import objectHash from 'object-hash';
import { hotkeys as mouseTrapAPI } from '../utils';
import Hotkey from './Hotkey';
import migrateOldHotkeyDefinitions from '../utils/hotkeys/migrateHotkeys';

/**
 *
 *
 * @typedef {Object} HotkeyDefinition
 * @property {String} commandName - Command to call
 * @property {Object} commandOptions - Command options
 * @property {String} label - Display name for hotkey
 * @property {String[]} keys - Keys to bind; Follows Mousetrap.js binding syntax
 */
export class HotkeysManager {
  private _servicesManager: AppTypes.ServicesManager;
  private _commandsManager: AppTypes.CommandsManager;
  private isEnabled: boolean = true;
  public hotkeyDefinitions: Record<string, any> = {};
  public hotkeyDefaults: any[] = [];
  /** True while the mouse cursor is inside this browser window. */
  private _hasMouse: boolean = false;
  /** Channel connecting all same-origin OHIF windows for hotkey routing. */
  private _channel: BroadcastChannel | null = null;
  /** Instance ids of other OHIF windows currently on the channel. */
  private _siblings: Set<string> = new Set();
  private _instanceId: string = Math.random().toString(36).slice(2);

  constructor(
    commandsManager: AppTypes.CommandsManager,
    servicesManager: AppTypes.ServicesManager
  ) {
    this._servicesManager = servicesManager;
    this._commandsManager = commandsManager;

    // Check for old hotkey definitions format and migrate if needed
    migrateOldHotkeyDefinitions({
      generateHash: this.generateHash,
    });
  }

  /**
   * Exposes Mousetrap.js's `.record` method, added by the record plugin.
   *
   * @param {*} event
   */
  record(event) {
    return mouseTrapAPI.record(event);
  }

  cancel() {
    mouseTrapAPI.stopRecord();
    mouseTrapAPI.unpause();
  }

  /**
   * Disables all hotkeys. Hotkeys added while disabled will not listen for
   * input.
   */
  disable() {
    this.isEnabled = false;
    mouseTrapAPI.pause();
  }

  /**
   * Enables all hotkeys.
   */
  enable() {
    this.isEnabled = true;
    mouseTrapAPI.unpause();
  }

  /**
   * Uses most recent
   *
   * @returns {undefined}
   */
  restoreDefaultBindings() {
    this.setHotkeys(this.hotkeyDefaults);
  }

  /**
   *
   */
  destroy() {
    this._teardownRouting();
    this.hotkeyDefaults = [];
    this.hotkeyDefinitions = {};
    mouseTrapAPI.reset();
  }

  /**
   * Registers a list of hotkey definitions.
   *
   * @param {HotkeyDefinition[] | Object} [hotkeyDefinitions=[]] Contains hotkeys definitions
   */
  setHotkeys(hotkeyDefinitions = []) {
    try {
      const definitions = this.getValidDefinitions(hotkeyDefinitions);
      definitions.forEach(definition => this.registerHotkeys(definition));
    } catch (error) {
      const { uiNotificationService } = this._servicesManager.services;
      uiNotificationService.show({
        title: 'Hotkeys Manager',
        message: 'Error while setting hotkeys',
        type: 'error',
      });
    }
  }

  generateHash(definition) {
    return objectHash({
      commandName: definition.commandName,
      commandOptions: definition.commandOptions || {},
    });
  }

  /**
   * Set default hotkey bindings. These
   * values are used in `this.restoreDefaultBindings`.
   *
   * @param {HotkeyDefinition[] | Object} [hotkeyDefinitions=[]] Contains hotkeys definitions
   */
  setDefaultHotKeys(hotkeyDefinitions = []) {
    const definitions = this.getValidDefinitions(hotkeyDefinitions);
    this.hotkeyDefaults = definitions;

    // Get user preferred keys from localStorage
    const userPreferredKeys = JSON.parse(localStorage.getItem('user-preferred-keys') || '{}');

    // Update definitions with user preferred keys before setting
    const updatedDefinitions = definitions.map(definition => {
      const commandHash = this.generateHash(definition);
      // If user has a preferred key binding, use it
      if (userPreferredKeys[commandHash]) {
        return {
          ...definition,
          keys: userPreferredKeys[commandHash],
        };
      }

      return definition;
    });

    this.setHotkeys(updatedDefinitions);
  }

  /**
   * Take hotkey definitions that can be an array or object and make sure that it
   * returns an array of hotkeys
   *
   * @param {HotkeyDefinition[] | Object} [hotkeyDefinitions=[]] Contains hotkeys definitions
   */
  getValidDefinitions(hotkeyDefinitions) {
    const definitions = Array.isArray(hotkeyDefinitions)
      ? [...hotkeyDefinitions]
      : this._parseToArrayLike(hotkeyDefinitions);

    // make sure isEditable is true for all definitions if not provided
    definitions.forEach(definition => {
      if (definition.isEditable === undefined) {
        definition.isEditable = true;
      }
    });

    return definitions;
  }

  /**
   * Take hotkey definitions that can be an array and make sure that it
   * returns an object of hotkeys definitions
   *
   * @param {HotkeyDefinition[]} [hotkeyDefinitions=[]] Contains hotkeys definitions
   * @returns {Object}
   */
  getValidHotkeyDefinitions(hotkeyDefinitions) {
    const definitions = this.getValidDefinitions(hotkeyDefinitions);
    const objectDefinitions = {};
    definitions.forEach(definition => {
      const { commandName, commandOptions } = definition;
      const commandHash = objectHash({ commandName, commandOptions });
      objectDefinitions[commandHash] = definition;
    });
    return objectDefinitions;
  }

  /**
   * It parses given object containing hotkeyDefinition to array like.
   * Each property of given object will be mapped to an object of an array. And its property name will be the value of a property named as commandName
   *
   * @param {HotkeyDefinition[] | Object} [hotkeyDefinitions={}] Contains hotkeys definitions
   * @returns {HotkeyDefinition[]}
   */
  _parseToArrayLike(hotkeyDefinitionsObj = {}) {
    const copy = { ...hotkeyDefinitionsObj };
    return Object.entries(copy).map(entryValue =>
      this._parseToHotKeyObj(entryValue[0], entryValue[1])
    );
  }

  /**
   * Return HotkeyDefinition object like based on given property name and property value
   * @param {string} propertyName property name of hotkey definition object
   * @param {object} propertyValue property value of hotkey definition object
   */
  _parseToHotKeyObj(propertyName, propertyValue) {
    return {
      commandName: propertyName,
      ...propertyValue,
    };
  }

  private _onMousePresent = () => {
    this._hasMouse = true;
  };

  private _onMouseLeave = () => {
    this._hasMouse = false;
  };

  private _onPageHide = () => {
    this._channel?.postMessage({ type: 'bye', id: this._instanceId });
  };

  // Tab-switching away fires no mouseleave, so _hasMouse would otherwise
  // stay stuck true and a hidden tab could execute (or double-execute)
  // forwarded commands invisibly.
  private _onVisibilityChange = () => {
    if (document.hidden) {
      this._hasMouse = false;
    }
  };

  // bfcache restore skips our pagehide 'bye' handling on the way back in:
  // the restored page still has its old channel/listeners and stale
  // _siblings, while siblings have already forgotten it. Re-form the mesh.
  private _onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) {
      this._siblings.clear();
      this._channel?.postMessage({ type: 'hello', id: this._instanceId });
    }
  };

  private _onChannelMessage = (event: MessageEvent) => {
    const { type, id, commandName, commandOptions, context } = event.data || {};
    switch (type) {
      case 'hello':
        if (id) {
          this._siblings.add(id);
          this._channel?.postMessage({ type: 'hello-ack', id: this._instanceId });
        }
        break;
      case 'hello-ack':
        if (id) {
          this._siblings.add(id);
        }
        break;
      case 'bye':
        this._siblings.delete(id);
        break;
      case 'run':
        // Execute only if this window is the one under the cursor, visible,
        // and its hotkeys are not paused (e.g. hotkey-recording dialog open).
        if (this._hasMouse && !document.hidden && this.isEnabled) {
          this._commandsManager.runCommand(commandName, { ...commandOptions }, context);
        }
        break;
    }
  };

  /**
   * Lazily joins the cross-window hotkey routing channel and starts tracking
   * whether the mouse cursor is inside this window. Mouse events fire in
   * windows without keyboard focus, which is what makes routing possible.
   * No-op when BroadcastChannel is unavailable (tests/older browsers).
   */
  private _ensureRouting() {
    if (this._channel || typeof BroadcastChannel === 'undefined') {
      return;
    }
    this._channel = new BroadcastChannel('ohif-hotkeys');
    this._channel.onmessage = this._onChannelMessage;
    this._channel.postMessage({ type: 'hello', id: this._instanceId });
    document.documentElement.addEventListener('mouseenter', this._onMousePresent);
    document.documentElement.addEventListener('mouseleave', this._onMouseLeave);
    document.addEventListener('mousemove', this._onMousePresent);
    window.addEventListener('pagehide', this._onPageHide);
    document.addEventListener('visibilitychange', this._onVisibilityChange);
    window.addEventListener('pageshow', this._onPageShow);
  }

  /**
   * Runs a hotkey command in the window that currently contains the mouse
   * cursor. Local execution when the cursor is here or when no sibling OHIF
   * windows are known (preserves single-window behavior, e.g. Alt+Tab focus).
   */
  private _runOrForward(commandName, commandOptions = {}, context, evt) {
    const shouldForward = this._channel && this._siblings.size > 0 && !this._hasMouse;
    if (!shouldForward) {
      this._commandsManager.runCommand(commandName, { evt, ...commandOptions }, context);
      return;
    }
    // evt is a DOM event and cannot cross BroadcastChannel (not cloneable);
    // preventDefault/stopPropagation already ran in this window.
    this._channel.postMessage({ type: 'run', commandName, commandOptions, context });
  }

  private _teardownRouting() {
    if (!this._channel) {
      return;
    }
    this._channel.postMessage({ type: 'bye', id: this._instanceId });
    this._channel.close();
    this._channel = null;
    this._siblings.clear();
    this._hasMouse = false;
    document.documentElement.removeEventListener('mouseenter', this._onMousePresent);
    document.documentElement.removeEventListener('mouseleave', this._onMouseLeave);
    document.removeEventListener('mousemove', this._onMousePresent);
    window.removeEventListener('pagehide', this._onPageHide);
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    window.removeEventListener('pageshow', this._onPageShow);
  }

  /**
   * (Unbinds and) binds the specified command to one or more key combinations.
   * When the hotkey combination is triggered, the command name and active contexts
   * are used to locate and execute the appropriate command.
   *
   * @param hotkey - The hotkey definition object.
   * @throws {Error} Throws an error if no commandName is provided.
   */
  registerHotkeys({
    commandName,
    commandOptions = {},
    context,
    keys,
    label,
    isEditable,
  }: Hotkey): void {
    if (!commandName) {
      throw new Error(`No command was defined for hotkey "${keys}"`);
    }

    const commandHash = this.generateHash({ commandName, commandOptions });
    const existingHotkey = this.hotkeyDefinitions[commandHash];

    // If the hotkey has already been registered with the same keys, skip re-registration.
    if (existingHotkey && existingHotkey.keys === keys) {
      console.debug('HotkeysManager: Identical hotkey registration skipped.');
      return;
    }

    const userPreferredKeys = JSON.parse(localStorage.getItem('user-preferred-keys') || '{}');

    if (existingHotkey) {
      userPreferredKeys[commandHash] = keys;
      localStorage.setItem('user-preferred-keys', JSON.stringify(userPreferredKeys));
      this._unbindHotkeys(commandName, existingHotkey.keys);
    }

    this.hotkeyDefinitions[commandHash] = { commandName, commandOptions, keys, label, isEditable };
    this._bindHotkeys(commandName, commandOptions, context, keys);
  }

  /**
   * Binds one or more set of hotkey combinations for a given command
   *
   * @private
   * @param {string} commandName - The name of the command to trigger when hotkeys are used
   * @param {string[]} keys - One or more key combinations that should trigger command
   * @returns {undefined}
   */
  _bindHotkeys(commandName, commandOptions = {}, context, keys) {
    const isKeyDefined = keys === '' || keys === undefined;
    if (isKeyDefined) {
      return;
    }

    const isKeyArray = keys instanceof Array;
    const combinedKeys = isKeyArray ? keys.join('+') : keys;

    this._ensureRouting();
    mouseTrapAPI.bind(combinedKeys, evt => {
      evt.preventDefault();
      evt.stopPropagation();
      this._runOrForward(commandName, commandOptions, context, evt);
    });
  }

  /**
   * unbinds one or more set of hotkey combinations for a given command
   *
   * @private
   * @param {string} commandName - The name of the previously bound command
   * @param {string[]} keys - One or more sets of previously bound keys
   * @returns {undefined}
   */
  _unbindHotkeys(commandName, keys) {
    const isKeyDefined = keys !== '' && keys !== undefined;
    if (!isKeyDefined) {
      return;
    }

    const isKeyArray = keys instanceof Array;
    if (isKeyArray) {
      const combinedKeys = keys.join('+');
      this._unbindHotkeys(commandName, combinedKeys);
      return;
    }

    mouseTrapAPI.unbind(keys);
  }
}

export default HotkeysManager;
