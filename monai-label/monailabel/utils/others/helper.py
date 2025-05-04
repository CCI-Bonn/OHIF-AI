import math

def clean_and_densify_polyline(polyline, max_segment_length=1):
    if not polyline or len(polyline) < 2:
        return []

    cleaned = []

    for i in range(len(polyline)):
        x1, y1, z = polyline[i]
        x2, y2, _ = polyline[(i + 1) % len(polyline)]  # wrap to start

        if x1 == x2 and y1 == y2:
            continue  # skip duplicate

        if not cleaned or (cleaned[-1][0] != x1 or cleaned[-1][1] != y1):
            cleaned.append([x1, y1, z])

        dx = x2 - x1
        dy = y2 - y1
        dist = math.hypot(dx, dy)

        if dist > max_segment_length:
            steps = math.floor(dist)
            for j in range(1, steps):
                t = j / steps
                px = round(x1 + dx * t)
                py = round(y1 + dy * t)

                last = cleaned[-1]
                if last[0] != px or last[1] != py:
                    cleaned.append([px, py, z])

    first_x, first_y, _ = cleaned[0]
    last_x, last_y, _ = cleaned[-1]
    if first_x != last_x or first_y != last_y:
        cleaned.append([first_x, first_y, z])

    return cleaned

def get_scanline_filled_points_3d(polyline):
    if not polyline or len(polyline) < 3:
        return []

    points = []

    min_x = min(pt[0] for pt in polyline)
    max_x = max(pt[0] for pt in polyline)

    z = polyline[0][2]  # Assume same z for all

    for x in range(math.floor(min_x), math.ceil(max_x) + 1):
        intersections = []

        for i in range(len(polyline)):
            x1, y1, _ = polyline[i]
            x2, y2, _ = polyline[(i + 1) % len(polyline)]

            if x1 == x2:
                continue  # skip vertical edges

            if (x1 <= x < x2) or (x2 <= x < x1):
                t = (x - x1) / (x2 - x1)
                y = y1 + t * (y2 - y1)
                intersections.append(y)

        intersections.sort()

        for j in range(0, len(intersections) - 1, 2):
            y_start = math.ceil(intersections[j])
            y_end = math.floor(intersections[j + 1])
            for y in range(y_start, y_end + 1):
                points.append([x, y, z])

    return points
