#!/usr/bin/env python3
"""Delete ONLY the SEG series a soak run created.

The fixture study already carries 5 pre-existing SEG series from manual testing
alongside a 694-instance CT series (31 series total). This script is therefore
STRICTLY ALLOWLIST-DRIVEN: it deletes exactly the Orthanc ids recorded in a
created-segs-*.json file and nothing else.

It NEVER queries Orthanc for "SEGs on the study".
It NEVER deletes by modality, by date, or by any heuristic.
Default behaviour is DRY RUN — pass --apply to delete for real.

If the allowlist file is missing, empty, or unparseable it deletes NOTHING
and explains why. A failure must be loud and safe, never silent.
"""

import argparse
import glob
import json
import os
import sys
import urllib.request


def delete_created(proxy: str, ids: list, dry_run: bool = True) -> list:
    """Delete exactly the listed Orthanc series ids.

    Args:
        proxy:   Orthanc base URL, e.g. "http://localhost:1030/pacs".
        ids:     Allowlist of Orthanc series ids to delete.
        dry_run: When True (the default) nothing is deleted.

    Returns:
        List of ids that were successfully deleted.
        Always empty when dry_run=True or ids=[].
    """
    if not ids:
        print("No ids to delete — nothing to do.")
        return []

    deleted = []
    for oid in ids:
        if dry_run:
            print(f"[dry-run] would delete {oid}")
            continue
        url = f"{proxy}/series/{oid}"
        req = urllib.request.Request(url, method="DELETE")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                if r.status < 300:
                    deleted.append(oid)
                    print(f"deleted {oid}")
                else:
                    print(f"WARN: unexpected status {r.status} for {oid}")
        except Exception as e:
            print(f"FAILED to delete {oid}: {e}")
    return deleted


def load_allowlist(path: str) -> list | None:
    """Load and validate the allowlist JSON file.

    Returns the list of ids, or None if the file cannot be used safely.
    Prints a clear explanation in every failure case.
    """
    if not os.path.exists(path):
        print(f"ERROR: allowlist file not found: {path}")
        print("Deleting NOTHING — supply a valid --run path or ensure a runs/ file exists.")
        return None

    try:
        with open(path) as fh:
            raw = fh.read().strip()
    except OSError as e:
        print(f"ERROR: cannot read {path}: {e}")
        print("Deleting NOTHING.")
        return None

    if not raw:
        print(f"ERROR: allowlist file is empty: {path}")
        print("Deleting NOTHING.")
        return None

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"ERROR: allowlist file is not valid JSON: {path}")
        print(f"  Parse error: {e}")
        print("Deleting NOTHING — refusing to fall back to any heuristic.")
        return None

    if not isinstance(data, list):
        print(f"ERROR: allowlist file must contain a JSON array, got {type(data).__name__}: {path}")
        print("Deleting NOTHING.")
        return None

    if len(data) == 0:
        print(f"Allowlist is an empty array in {path} — nothing to delete.")
        return []

    # Validate every element is a non-empty string.
    for idx, elem in enumerate(data):
        if not isinstance(elem, str) or not elem:
            print(f"ERROR: allowlist element at index {idx} is not a non-empty string: {elem!r}")
            print("Deleting NOTHING — all allowlist entries must be valid Orthanc series ids.")
            return None

    return data


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "--proxy",
        default="http://localhost:1030/pacs",
        help="Orthanc base URL (default: http://localhost:1030/pacs)",
    )
    ap.add_argument(
        "--run",
        metavar="PATH",
        help="Path to created-segs-*.json from a soak run. "
             "Defaults to the newest file in runs/.",
    )
    ap.add_argument(
        "--apply",
        action="store_true",
        help="Actually delete. Without this flag the script only prints what it would do.",
    )
    a = ap.parse_args()

    # Resolve the allowlist path.
    if a.run:
        path = a.run
    else:
        pattern = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runs", "created-segs-*.json")
        candidates = glob.glob(pattern)
        if not candidates:
            print(f"ERROR: no created-segs-*.json files found in {os.path.dirname(pattern)}")
            print("Deleting NOTHING — run the soak first or supply --run <path>.")
            return 1
        path = max(candidates, key=os.path.getmtime)
        print(f"Using newest allowlist: {path}")

    ids = load_allowlist(path)
    if ids is None:
        # load_allowlist already printed the reason.
        return 1

    if len(ids) == 0:
        return 0

    dry_run = not a.apply
    mode = "DRY RUN" if dry_run else "LIVE — data will be deleted"
    print(f"\n{len(ids)} SEG series in allowlist | mode: {mode}")
    if dry_run:
        print("Pass --apply to delete for real.\n")

    done = delete_created(a.proxy, ids, dry_run=dry_run)

    if not dry_run:
        print(f"\nDeleted {len(done)} / {len(ids)} series.")
        if len(done) < len(ids):
            failed = len(ids) - len(done)
            print(f"ERROR: {failed} deletion(s) failed. Aborting.")
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
