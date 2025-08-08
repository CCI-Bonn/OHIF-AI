import React, { useState, useEffect } from 'react';
import { ScrollArea, DataRow } from '../../components';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '../../components/HoverCard';
import { useSystem } from '@ohif/core';
import { useSegmentationTableContext, useSegmentationExpanded } from './contexts';
import { SegmentStatistics } from './SegmentStatistics';
import { useDynamicMaxHeight } from '../../hooks/useDynamicMaxHeight';

export const SegmentationSegments = ({ children = null }: { children?: React.ReactNode }) => {
  const { servicesManager } = useSystem();
  const [forceUpdate, setForceUpdate] = useState(0);
  const {
    activeSegmentationId,
    disableEditing,
    onSegmentColorClick,
    onToggleSegmentVisibility,
    onToggleSegmentMeasurement,
    onToggleSegmentLock,
    onSegmentClick,
    onSegmentEdit,
    onSegmentDelete,
    data,
  } = useSegmentationTableContext('SegmentationSegments');

  // Listen for measurement visibility changes to force re-render
  useEffect(() => {
    const handleMeasurementVisibilityChange = () => {
      setForceUpdate(prev => prev + 1);
    };

    document.addEventListener('measurement-state-changed', handleMeasurementVisibilityChange);
    
    return () => {
      document.removeEventListener('measurement-state-changed', handleMeasurementVisibilityChange);
    };
  }, []);

  // Custom hook to get measurement visibility with proper reactivity
  const useMeasurementVisibility = (segmentationId: string, segmentIndex: number) => {
    const [isVisible, setIsVisible] = useState(true);
    
    useEffect(() => {
      const updateVisibility = () => {
        const visibility = (servicesManager.services as any).segmentationService.getSegmentMeasurementVisibility(
          segmentationId,
          segmentIndex
        );
        setIsVisible(visibility);
      };
      
      // Update immediately
      updateVisibility();
      
      // Set up interval to check for changes
      const interval = setInterval(updateVisibility, 100);
      
      return () => clearInterval(interval);
    }, [segmentationId, segmentIndex, forceUpdate]);
    
    return isVisible;
  };

  // Try to get segmentation data from expanded context first, then fall back to table context
  let segmentation;
  let representation;

  try {
    // Try to use the SegmentationExpanded context if available
    const segmentationInfo = useSegmentationExpanded('SegmentationSegments');
    segmentation = segmentationInfo.segmentation;
    representation = segmentationInfo.representation;
  } catch (e) {
    // Not within SegmentationExpanded context, get from active segmentation
    const segmentationInfo = data.find(
      entry => entry.segmentation.segmentationId === activeSegmentationId
    );
    segmentation = segmentationInfo?.segmentation;
    representation = segmentationInfo?.representation;
  }

  const segments = Object.values(representation.segments);
  const isActiveSegmentation = segmentation.segmentationId === activeSegmentationId;

  const { ref: scrollableContainerRef, maxHeight } = useDynamicMaxHeight(segments);

  if (!representation || !segmentation) {
    return null;
  }

  return (
    <ScrollArea
      className={`bg-bkg-low space-y-px`}
      showArrows={true}
    >
      <div
        ref={scrollableContainerRef}
        style={{ maxHeight: maxHeight }}
      >
        {segments.map(segment => {
          if (!segment) {
            return null;
          }
          const { segmentIndex, color, visible } = segment as {
            segmentIndex: number;
            color: number[];
            visible: boolean;
          };
          const segmentFromSegmentation = segmentation.segments[segmentIndex];

          if (!segmentFromSegmentation) {
            return null;
          }

          const { locked, active, label, displayText } = segmentFromSegmentation;
          const cssColor = `rgb(${color[0]},${color[1]},${color[2]})`;

          const hasStats = segmentFromSegmentation.cachedStats?.namedStats;
          
          // Use custom hook to get measurement visibility with proper reactivity
          const isMeasurementVisible = useMeasurementVisibility(segmentation.segmentationId, segmentIndex);
          
          const DataRowComponent = (
            <DataRow
              key={segmentIndex}
              number={segmentIndex}
              title={label}
              // details={displayText}
              description={displayText}
              colorHex={cssColor}
              isSelected={active}
              isVisible={visible}
              isMeasurementVisible={isMeasurementVisible}
              isLocked={locked}
              disableEditing={disableEditing}
              className={!isActiveSegmentation ? 'opacity-80' : ''}
              onColor={() => onSegmentColorClick(segmentation.segmentationId, segmentIndex)}
              onToggleVisibility={() =>
                onToggleSegmentVisibility(
                  segmentation.segmentationId,
                  segmentIndex,
                  representation.type
                )
              }
              onToggleMeasurement={() => onToggleSegmentMeasurement(segmentation.segmentationId, segmentIndex)}
              onToggleLocked={() => onToggleSegmentLock(segmentation.segmentationId, segmentIndex)}
              onSelect={() => onSegmentClick(segmentation.segmentationId, segmentIndex)}
              onRename={() => onSegmentEdit(segmentation.segmentationId, segmentIndex)}
              onDelete={() => onSegmentDelete(segmentation.segmentationId, segmentIndex)}
            />
          );

          return hasStats ? (
            <HoverCard
              key={`hover-${segmentIndex}`}
              openDelay={300}
            >
              <HoverCardTrigger asChild>
                <div>{DataRowComponent}</div>
              </HoverCardTrigger>
              <HoverCardContent
                side="left"
                align="start"
                className="w-72 border"
              >
                <div className="mb-4 flex items-center space-x-2">
                  <div
                    className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: cssColor }}
                  ></div>
                  <h3 className="text-muted-foreground break-words font-semibold">{label}</h3>
                </div>

                <SegmentStatistics
                  segment={{
                    ...segmentFromSegmentation,
                    segmentIndex,
                  }}
                  segmentationId={segmentation.segmentationId}
                >
                  {children}
                </SegmentStatistics>
              </HoverCardContent>
            </HoverCard>
          ) : (
            DataRowComponent
          );
        })}
      </div>
    </ScrollArea>
  );
};

SegmentationSegments.displayName = 'SegmentationTable.Segments';
