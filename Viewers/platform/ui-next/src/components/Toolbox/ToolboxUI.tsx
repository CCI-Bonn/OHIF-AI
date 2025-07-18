import React, { useEffect, useRef, useState } from 'react';
import { PanelSection } from '../../components';
// Migrate this file to the new UI eventually
import { ToolSettings } from '@ohif/ui';
import { SwitchButton } from '@ohif/ui';
import classnames from 'classnames';
import { toolboxState } from '../../../../../extensions/default/src/stores/toolboxState';

const ItemsPerRow = 4;

function usePrevious(value) {
  const ref = useRef();
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}

/**
 * Just refactoring from the toolbox component to make it more readable
 */
function ToolboxUI(props: withAppTypes) {
  const {
    toolbarButtons,
    handleToolSelect,
    toolboxState: localToolboxState,
    numRows,
    servicesManager,
    title,
    useCollapsedPanel = true,
  } = props;

  // Local state for UI updates
  const [liveMode, setLiveMode] = useState(toolboxState.getLiveMode());
  const [posNeg, setPosNeg] = useState(toolboxState.getPosNeg());

  const { activeTool, toolOptions, selectedEvent } = localToolboxState;
  const activeToolOptions = toolOptions?.[activeTool];

  const prevToolOptions = usePrevious(activeToolOptions);

  useEffect(() => {
    if (!activeToolOptions || Array.isArray(activeToolOptions) === false) {
      return;
    }

    activeToolOptions.forEach((option, index) => {
      const prevOption = prevToolOptions ? prevToolOptions[index] : undefined;
      if (!prevOption || option.value !== prevOption.value || selectedEvent) {
        const isOptionValid = option.condition
          ? option.condition({ options: activeToolOptions })
          : true;
        if (isOptionValid) {
          const { commands } = option;
          commands(option.value);
        }
      }
    });
  }, [activeToolOptions, selectedEvent]);

  const render = () => {
    return (
      <>
      {title === "AI Tools" && (
          <div className="bg-primary-dark px-2 py-2" style={{ color: 'white' }}>
            <div className="flex flex-col gap-2">
              <SwitchButton
                label="Live Mode"
                checked={liveMode}
                onChange={(checked) => {
                  setLiveMode(checked);
                  toolboxState.setLiveMode(checked);
                  console.log('Live mode:', checked);
                }}
              />
              <SwitchButton
                label="Pos/Neg"
                checked={posNeg}
                onChange={(checked) => {
                  setPosNeg(checked);
                  toolboxState.setPosNeg(checked);
                  console.log('Pos/Neg:', checked);
                }}
              />
            </div>
          </div>
        )}
        <div className="flex flex-col bg-black">
          <div className="bg-primary-dark mt-0.5 flex flex-wrap py-2">
            {toolbarButtons.map((toolDef, index) => {
              if (!toolDef) {
                return null;
              }

              const { id, Component, componentProps } = toolDef;
              const isLastRow = Math.floor(index / ItemsPerRow) + 1 === numRows;

              const toolClasses = `ml-1 ${isLastRow ? '' : 'mb-2'}`;

              const onInteraction = ({ itemId, id, commands }) => {
                const idToUse = itemId || id;
                handleToolSelect(idToUse);
                props.onInteraction({
                  itemId,
                  commands,
                });
              };

              return (
                <div
                  key={id}
                  className={classnames({
                    [toolClasses]: true,
                    'border-secondary-light flex flex-col items-center justify-center rounded-md border':
                      true,
                  })}
                >
                  <div className="flex rounded-md bg-black">
                    <Component
                      {...componentProps}
                      {...props}
                      id={id}
                      servicesManager={servicesManager}
                      onInteraction={onInteraction}
                      size="toolbox"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="bg-primary-dark h-auto px-2">
          {activeToolOptions && <ToolSettings options={activeToolOptions} />}
        </div>
      </>
    );
  };

  return (
    <>
      {useCollapsedPanel ? (
        <PanelSection>
          <PanelSection.Header>
            <span>{title}</span>
          </PanelSection.Header>
          <PanelSection.Content className="flex-shrink-0">{render()}</PanelSection.Content>
        </PanelSection>
      ) : (
        render()
      )}
    </>
  );
}

export { ToolboxUI };
