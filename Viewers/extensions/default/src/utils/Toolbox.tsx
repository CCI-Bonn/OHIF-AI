import React, { useState, useEffect } from 'react';
import { Icons, PanelSection, ToolSettings, Switch, Label } from '@ohif/ui-next';
import { useSystem, useToolbar } from '@ohif/core';
import classnames from 'classnames';
import { useTranslation } from 'react-i18next';
import { toolboxState } from '../stores/toolboxState';

interface ButtonProps {
  isActive?: boolean;
  options?: unknown;
}

/**
 * A toolbox is a collection of buttons and commands that they invoke, used to provide
 * custom control panels to users. This component is a generic UI component that
 * interacts with services and commands in a generic fashion. While it might
 * seem unconventional to import it from the UI and integrate it into the JSX,
 * it belongs in the UI components as there isn't anything in this component that
 * couldn't be used for a completely different type of app. It plays a crucial
 * role in enhancing the app with a toolbox by providing a way to integrate
 * and display various tools and their corresponding options
 */
export function Toolbox({ buttonSectionId, title }: { buttonSectionId: string; title: string }) {
  const { servicesManager, commandsManager } = useSystem();
  const { t } = useTranslation();

  const { toolbarService, customizationService } = servicesManager.services;
  const [showConfig, setShowConfig] = useState(false);
  const [locked, setLocked] = useState(false);

  // Local state for UI updates
  const [liveMode, setLiveMode] = useState(toolboxState.getLiveMode());
  const [posNeg, setPosNeg] = useState(toolboxState.getPosNeg());
  const [refineNew, setRefineNew] = useState(toolboxState.getRefineNew());
  const [nnInterSam2, setNnInterSam2] = useState(toolboxState.getNnInterSam2());
  const [medSam2, setMedSam2] = useState(toolboxState.getMedSam2());

  // Sync local state with global state changes
  useEffect(() => {
    const updateLocalState = () => {
      setLiveMode(toolboxState.getLiveMode());
      setPosNeg(toolboxState.getPosNeg());
      setRefineNew(toolboxState.getRefineNew());
      setNnInterSam2(toolboxState.getNnInterSam2());
      setMedSam2(toolboxState.getMedSam2());
    };

    // Update immediately
    updateLocalState();

    // Set up an interval to check for changes (since toolboxState doesn't have events)
    const interval = setInterval(updateLocalState, 100);

    return () => clearInterval(interval);
  }, []);

  // Keyboard hotkey handler for Live Mode toggle
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if the pressed key is 'Q' or 'q'
      if ((event.key === 'Q' || event.key === 'q')) {
        // Only trigger if we're not typing in an input field
        const activeElement = document.activeElement;
        const isInputField = activeElement?.tagName === 'INPUT' || 
                           activeElement?.tagName === 'TEXTAREA' || 
                           (activeElement as HTMLElement)?.contentEditable === 'true';
        
        if (!isInputField) {
          event.preventDefault();
          const newLiveMode = !liveMode;
          setLiveMode(newLiveMode);
          toolboxState.setLiveMode(newLiveMode);
          console.log('Live mode toggled via hotkey (q):', newLiveMode);
        }
      }
    };

    // Add event listener
    document.addEventListener('keydown', handleKeyDown);

    // Cleanup
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [liveMode]);

  // Keyboard hotkey handler for Pos/Neg toggle
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if the pressed key is 'W' or 'w'
      if ((event.key === 'W' || event.key === 'w')) {
        // Only trigger if we're not typing in an input field
        const activeElement = document.activeElement;
        const isInputField = activeElement?.tagName === 'INPUT' || 
                           activeElement?.tagName === 'TEXTAREA' || 
                           (activeElement as HTMLElement)?.contentEditable === 'true';
        
        if (!isInputField) {
          event.preventDefault();
          const newPosNeg = !posNeg;
          setPosNeg(newPosNeg);
          toolboxState.setPosNeg(newPosNeg);
          console.log('Pos/Neg toggled via hotkey (w):', newPosNeg);
        }
      }
    };

    // Add event listener
    document.addEventListener('keydown', handleKeyDown);

    // Cleanup
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [posNeg]);

  // Keyboard hotkey handler for Refine/New toggle
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if the pressed key is 'E' or 'e'
      if ((event.key === 'E' || event.key === 'e')) {
        // Only trigger if we're not typing in an input field
        const activeElement = document.activeElement;
        const isInputField = activeElement?.tagName === 'INPUT' || 
                           activeElement?.tagName === 'TEXTAREA' || 
                           (activeElement as HTMLElement)?.contentEditable === 'true';
        
        if (!isInputField) {
          event.preventDefault();
          const newRefineNew = !refineNew;
          setRefineNew(newRefineNew);
          toolboxState.setRefineNew(newRefineNew);
          console.log('Refine/New toggled via hotkey (e):', newRefineNew);
        }
      }
    };

    // Add event listener
    document.addEventListener('keydown', handleKeyDown);

    // Cleanup
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [refineNew]);

  // When locked, force Pan tool active, disable live prompts, and collapse section
  useEffect(() => {
    if (locked) {
      try {
        // Disable live mode to avoid unintended inference
        if (liveMode) {
          setLiveMode(false);
          toolboxState.setLiveMode(false);
        }
        // Activate Pan tool
        commandsManager?.run?.('setToolActive', { toolName: 'Pan' });
      } catch (e) {
        // no-op
      }
    }
  }, [locked]);

  // Keyboard hotkey handler for nnInter/SAM2 toggle
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if the pressed key is 'T' or 't'
      if ((event.key === 'T' || event.key === 't')) {
        // Only trigger if we're not typing in an input field
        const activeElement = document.activeElement;
        const isInputField = activeElement?.tagName === 'INPUT' || 
                           activeElement?.tagName === 'TEXTAREA' || 
                           (activeElement as HTMLElement)?.contentEditable === 'true';
        
        if (!isInputField) {
          event.preventDefault();
          const newNnInterSam2 = !nnInterSam2;
          setNnInterSam2(newNnInterSam2);
          toolboxState.setNnInterSam2(newNnInterSam2);
          console.log('nnInter/SAM2 toggled via hotkey (r):', newNnInterSam2);
        }
      }
    };

    // Add event listener
    document.addEventListener('keydown', handleKeyDown);

    // Cleanup
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [nnInterSam2]);

  const { toolbarButtons: toolboxSections, onInteraction } = useToolbar({
    servicesManager,
    buttonSection: buttonSectionId,
  });

  if (!toolboxSections.length) {
    return null;
  }

  // Ensure we have proper button sections at the top level.
  if (!toolboxSections.every(section => section.componentProps.buttonSection)) {
    throw new Error(
      'Toolbox accepts only button sections at the top level, not buttons. Create at least one button section.'
    );
  }

  // Helper to check a list of buttons for an active tool.
  const findActiveOptions = (buttons: any[]): unknown => {
    for (const tool of buttons) {
      if (tool.componentProps.isActive) {
        return tool.componentProps.options;
      }
      if (tool.componentProps.buttonSection) {
        const nestedButtons = toolbarService.getButtonPropsInButtonSection(
          tool.componentProps.buttonSection
        ) as ButtonProps[];
        const activeNested = nestedButtons.find(nested => nested.isActive);
        if (activeNested) {
          return activeNested.options;
        }
      }
    }
    return null;
  };

  // Look for active tool options across all sections.
  const activeToolOptions = toolboxSections.reduce((activeOptions, section) => {
    if (activeOptions) {
      return activeOptions;
    }
    const sectionId = section.componentProps.buttonSection;
    const buttons = toolbarService.getButtonSection(sectionId);
    return findActiveOptions(buttons);
  }, null);

  // Define the interaction handler once.
  const handleInteraction = ({ itemId }: { itemId: string }) => {
    if (locked && itemId !== 'Pan') {
      // Prevent tool changes when locked; keep Pan active
      commandsManager?.run?.('setToolActive', { toolName: 'Pan' });
      return;
    }
    onInteraction?.({ itemId });
  };

  const CustomConfigComponent = customizationService.getCustomization(`${buttonSectionId}.config`);
  
  const isAIToolBox = buttonSectionId === "aiToolBox";
  const shouldCollapse = isAIToolBox && locked;

  return (
    <PanelSection key={isAIToolBox ? `toolbox-${locked}` : buttonSectionId} defaultOpen={!shouldCollapse}>
      <PanelSection.Header 
        className="flex items-center justify-between"
      >
        <span className={classnames("flex items-center gap-2", { 
          "pointer-events-none": shouldCollapse 
        })}>
          <span className="pointer-events-auto">{t(title)}</span>
          {isAIToolBox && (
            <button
              type="button"
              className={classnames('ml-2 h-5 w-5 text-primary hover:opacity-80 pointer-events-auto cursor-pointer')}
              onClick={e => {
                e.stopPropagation();
                const next = !locked;
                setLocked(next);
                if (next) {
                  commandsManager?.run?.('setToolActive', { toolName: 'Pan' });
                }
              }}
              aria-label={locked ? 'Unlock tools' : 'Lock tools'}
              title={locked ? 'Unlock tools' : 'Lock tools'}
            >
              <Icons.Lock className={classnames('h-4 w-4', { 'opacity-40': !locked })} />
            </button>
          )}
        </span>
        {CustomConfigComponent && (
          <div className="ml-auto mr-2">
            <Icons.Settings
              className="text-primary h-4 w-4"
              onClick={e => {
                e.stopPropagation();
                setShowConfig(!showConfig);
              }}
            />
          </div>
        )}
      </PanelSection.Header>

      {!shouldCollapse && (
      <PanelSection.Content className="bg-muted flex-shrink-0 border-none">
        {showConfig && <CustomConfigComponent />}
        {toolboxSections.map(section => {
          const sectionId = section.componentProps.buttonSection;
          const buttons = toolbarService.getButtonSection(sectionId) as any[];

          return (
            <React.Fragment key={sectionId}>
                               {buttonSectionId === "aiToolBox" && (
                 <div className="flex justify-center items-center gap-4 py-2 px-1">
                   <div className="flex items-center gap-2">
                     <Label htmlFor="live-mode">Live Mode</Label>
                     <Switch
                       id="live-mode"
                       checked={liveMode}
                       onCheckedChange={(checked) => {
                        setLiveMode(checked);
                        toolboxState.setLiveMode(checked);
                        console.log('Live mode:', checked);
                       }}
                     />
                   </div>
                   <div className="flex items-center gap-2">
                     <Label htmlFor="pos-neg">Pos/Neg</Label>
                     <Switch
                       id="pos-neg"
                       checked={posNeg}
                       onCheckedChange={(checked) => {
                        setPosNeg(checked);
                        toolboxState.setPosNeg(checked);
                        console.log('Pos/Neg:', checked);
                      }}
                     />
                   </div>
                   <div className="flex items-center gap-2">
                     <Label htmlFor="refine-new">Refine/New</Label>
                     <Switch
                       id="refine-new"
                       checked={refineNew}
                       onCheckedChange={(checked) => {
                        setRefineNew(checked);
                        toolboxState.setRefineNew(checked);
                        console.log('Refine/New:', checked);
                      }}
                     />
                   </div>
                   <div className="flex items-center gap-2">
                     <Label htmlFor="nninter-sam2">nnInter/SAM2</Label>
                     <Switch
                       id="nninter-sam2"
                       checked={nnInterSam2}
                       onCheckedChange={(checked) => {
                        setNnInterSam2(checked);
                        toolboxState.setNnInterSam2(checked);
                        console.log('nnInter/SAM2:', checked);
                      }}
                     />
                   </div>
                   {/* Uncomment the below to use MedSAM2
                   <div className="flex items-center gap-2">
                     <Label htmlFor="medsam2">MedSAM2</Label>
                     <Switch
                       id="medsam2"
                       checked={medSam2}
                       onCheckedChange={(checked) => {
                        setMedSam2(checked);
                        toolboxState.setMedSam2(checked);
                        console.log('MedSAM2:', checked);
                      }}
                     />
                   </div> */}
                 </div>
                )}
              <div
                className="bg-muted flex flex-wrap space-x-2 py-2 px-1"
              >
              {buttons.map(tool => {
                if (!tool) {
                  return null;
                }
                const { id, Component, componentProps } = tool;

                return (
                  <div
                    key={id}
                    className={classnames('ml-1')}
                  >
                    <Component
                      {...componentProps}
                      id={id}
                      onInteraction={handleInteraction}
                      size="toolbox"
                      servicesManager={servicesManager}
                    />
                  </div>
                );
              })}
            </div>
            </React.Fragment>
          );
        })}
        {activeToolOptions && (
          <div className="bg-primary-dark mt-1 h-auto px-2">
            <ToolSettings options={activeToolOptions} />
          </div>
        )}
      </PanelSection.Content>
      )}
    </PanelSection>
  );
}
