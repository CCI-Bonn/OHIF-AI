import React from 'react';
import { PanelPancreasAngle } from './components/PanelPancreasAngle';

function getCustomizationModule({ commandsManager, servicesManager }) {
  const WrappedPanelPancreasAngle = () => (
    <PanelPancreasAngle
      commandsManager={commandsManager}
      servicesManager={servicesManager}
    />
  );

  return [
    {
      name: 'default',
      value: {
        'panelSegmentation.afterContent': WrappedPanelPancreasAngle,
      },
    },
  ];
}

export default getCustomizationModule;
