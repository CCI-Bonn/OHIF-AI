import React from 'react';
import { PanelPancreasAngle } from './components/PanelPancreasAngle';

function getPanelModule({ commandsManager, servicesManager }) {
  const wrappedPanel = () => (
    <PanelPancreasAngle
      commandsManager={commandsManager}
      servicesManager={servicesManager}
    />
  );

  return [
    {
      name: 'panelPancreasAngle',
      iconName: 'tab-linear',
      iconLabel: 'Pancreas',
      label: 'Pancreas Angles',
      component: wrappedPanel,
    },
  ];
}

export default getPanelModule;
