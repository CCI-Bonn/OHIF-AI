import React from 'react';
import { SegmentStatisticsProvider, useSegmentStatistics } from './contexts';
import { roundNumber } from '../../utils';

// Default statistics component
const DefaultStatsList = () => {
  const { namedStats, segment } = useSegmentStatistics('DefaultStatsList');
  const statsPending = !!segment?.cachedStats?.statsPending;

  // Nothing to show and nothing running.
  if (!namedStats && !statsPending) {
    return null;
  }

  const isFiniteNumber = (value: unknown): boolean =>
    Array.isArray(value) ? value.every(v => Number.isFinite(v)) : Number.isFinite(value as number);

  const handleNumber = (value: number) => {
    if (value === null) {
      return '';
    }

    if (Array.isArray(value)) {
      return value.map(handleNumber).join(', ');
    }

    return roundNumber(value);
  };

  // Sort namedStats entries by order property. Skip non-finite (NaN/Inf) values —
  // these appear transiently while stats are still being computed.
  const sortedStats = Object.entries(namedStats ?? {})
    .filter(
      ([_, stat]) =>
        stat && stat.value !== null && stat.name !== 'bidirectional' && isFiniteNumber(stat.value)
    )
    .sort((a, b) => {
      const orderA = a[1]?.order ?? Number.MAX_SAFE_INTEGER;
      const orderB = b[1]?.order ?? Number.MAX_SAFE_INTEGER;
      return orderA - orderB;
    });

  return (
    <div className="space-y-1">
      {statsPending && (
        <div className="text-muted-foreground flex items-center gap-1 italic">
          <span>Calculating…</span>
        </div>
      )}
      {sortedStats.map(([key, stat]) => {
        const { label, value, unit } = stat;

        return (
          <div
            key={key}
            className="flex justify-between"
          >
            <div>{label}</div>
            <div>
              <span className="text-white">{handleNumber(value)}</span>{' '}
              <span className="">{unit && unit !== 'none' ? unit : ''}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
};

// Root component that serves as the container and context provider
const SegmentStatisticsRoot = ({ segment, segmentationId, children }) => {
  if (!segment) {
    return null;
  }

  return (
    <SegmentStatisticsProvider
      segment={segment}
      segmentationId={segmentationId}
    >
      <div className="segment-statistics w-full">{children}</div>
    </SegmentStatisticsProvider>
  );
};

const SegmentStatisticsTitle = ({ children = null }: { children?: React.ReactNode }) => {
  return <div className="mb-2">{children}</div>;
};
const SegmentStatisticsHeader = ({ children = null }: { children?: React.ReactNode }) => {
  const { segment, segmentationId } = useSegmentStatistics('SegmentStatisticsHeader');
  const { segmentIndex } = segment;

  return (
    <div className="mb-3">
      {children &&
        React.cloneElement(children as React.ReactElement, { segmentationId, segmentIndex })}
    </div>
  );
};

const SegmentStatisticsBody = ({ children = null }: { children?: React.ReactNode }) => {
  return <div className="segment-statistics-body">{children || <DefaultStatsList />}</div>;
};

const SegmentStatisticsFooter = ({ children = null }: { children?: React.ReactNode }) => {
  return <div className="mt-3">{children}</div>;
};

// Create a compound component structure
const SegmentStatistics = Object.assign(SegmentStatisticsRoot, {
  Title: SegmentStatisticsTitle,
  Header: SegmentStatisticsHeader,
  Body: SegmentStatisticsBody,
  Footer: SegmentStatisticsFooter,
});

export { SegmentStatistics };
export { useSegmentStatistics };
