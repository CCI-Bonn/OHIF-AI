import { Types } from '@ohif/core';
import getPanelModule from './getPanelModule';
import getCommandsModule from './getCommandsModule';
import getCustomizationModule from './getCustomizationModule';
import PancreasAngleService from './services/PancreasAngleService';

const extension = {
  /**
   * Unique extension ID. Must match the name used in pluginImports.js
   * and the panel/command namespaces.
   */
  id: '@ohif/extension-pancrea-seg',

  preRegistration({ servicesManager }: Types.Extensions.ExtensionParams) {
    servicesManager.registerService(PancreasAngleService.REGISTRATION);
  },

  getPanelModule,

  getCustomizationModule,

  getCommandsModule({ servicesManager, commandsManager }: Types.Extensions.ExtensionParams) {
    return getCommandsModule({ servicesManager, commandsManager });
  },
};

export default extension;
