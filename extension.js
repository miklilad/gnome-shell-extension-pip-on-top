/*
 * GNOME Shell Extension: PiP on top
 * Developer: Rafostar
 */

import Meta from 'gi://Meta';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class PipOnTop extends Extension
{
  enable()
  {
    this._lastWorkspace = null;
    this._windowAddedId = 0;
    this._windowRemovedId = 0;
    this._focusFixId = 0;

    this.settings = this.getSettings();
    this._settingsChangedId = this.settings.connect(
      'changed', this._onSettingsChanged.bind(this));

    this._switchWorkspaceId = global.window_manager.connect_after(
      'switch-workspace', this._onSwitchWorkspace.bind(this));
    this._onSwitchWorkspace();
  }

  disable()
  {
    this.settings.disconnect(this._settingsChangedId);
    this.settings = null;

    global.window_manager.disconnect(this._switchWorkspaceId);

    if (this._focusFixId) {
      global.compositor.get_laters().remove(this._focusFixId);
      this._focusFixId = 0;
    }

    if (this._lastWorkspace) {
      this._lastWorkspace.disconnect(this._windowAddedId);
      this._lastWorkspace.disconnect(this._windowRemovedId);
    }

    this._lastWorkspace = null;
    this._settingsChangedId = 0;
    this._switchWorkspaceId = 0;
    this._windowAddedId = 0;
    this._windowRemovedId = 0;
    this._focusFixId = 0;

    let actors = global.get_window_actors();
    if (actors) {
      for (let actor of actors) {
        let window = actor.meta_window;
        if (!window) continue;

        if (window._isPipAble) {
          if (window.above)
            window.unmake_above();
          if (window.on_all_workspaces)
            window.unstick();
        }

        this._onWindowRemoved(null, window);
      }
    }
  }

  _onSettingsChanged(settings, key)
  {
    switch (key) {
      case 'stick':
        /* Updates already present windows */
        this._onSwitchWorkspace();
        break;
      default:
        break;
    }
  }

  _onSwitchWorkspace()
  {
    let workspace = global.workspace_manager.get_active_workspace();
    let wsWindows = global.display.get_tab_list(Meta.TabList.NORMAL, workspace);

    if (this._lastWorkspace) {
      this._lastWorkspace.disconnect(this._windowAddedId);
      this._lastWorkspace.disconnect(this._windowRemovedId);
    }

    this._lastWorkspace = workspace;
    this._windowAddedId = this._lastWorkspace.connect(
      'window-added', this._onWindowAdded.bind(this));
    this._windowRemovedId = this._lastWorkspace.connect(
      'window-removed', this._onWindowRemoved.bind(this));

    /* Update state on already present windows */
    if (wsWindows) {
      for (let window of wsWindows)
        this._onWindowAdded(workspace, window);
    }

    /* A PiP window is kept always-on-top, so it is the topmost window
     * in the stack. With click-to-focus GNOME focuses the topmost
     * window when switching workspaces, which makes the (sticky) PiP
     * steal focus. Once focus has settled, hand it back to the real
     * top window of the workspace. */
    this._queueFocusFix();
  }

  _queueFocusFix()
  {
    if (this._focusFixId)
      return;

    let laters = global.compositor.get_laters();
    this._focusFixId = laters.add(Meta.LaterType.IDLE, () => {
      this._focusFixId = 0;
      this._fixStolenFocus();
      return false;
    });
  }

  _fixStolenFocus()
  {
    let focus = global.display.get_focus_window();
    /* Only intervene when an always-on-top PiP grabbed the focus. */
    if (!focus || !focus._isPipAble || !focus.above)
      return;

    let workspace = global.workspace_manager.get_active_workspace();
    let wsWindows = global.display.get_tab_list(Meta.TabList.NORMAL, workspace);
    if (!wsWindows)
      return;

    /* Tab list is most-recently-used ordered; focus the top window
     * that is not a PiP. If there is none, leave the PiP focused. */
    for (let window of wsWindows) {
      if (window._isPipAble && window.above)
        continue;

      window.activate(global.get_current_time());
      return;
    }
  }

  _onWindowAdded(workspace, window)
  {
    if (!window._notifyPipTitleId) {
      window._notifyPipTitleId = window.connect_after(
        'notify::title', this._checkTitle.bind(this));
    }
    this._checkTitle(window);
  }

  _onWindowRemoved(workspace, window)
  {
    if (window._notifyPipTitleId) {
      window.disconnect(window._notifyPipTitleId);
      window._notifyPipTitleId = null;
    }
    if (window._isPipAble)
      window._isPipAble = null;
  }

  _isChromiumDocPip(window)
  {
    /* Map known Chromium-based browser wm_class values to the suffix
     * they append to normal window titles (" - <Browser>"). A Document
     * Picture-in-Picture pop-out keeps the wm_class but lacks that suffix. */
    const browsers = {
      'google-chrome': 'Google Chrome',
      'Google-chrome': 'Google Chrome',
      'chromium': 'Chromium',
      'Chromium': 'Chromium',
      'chromium-browser': 'Chromium',
      'brave-browser': 'Brave',
      'Brave-browser': 'Brave',
      'microsoft-edge': 'Microsoft Edge',
      'Microsoft-edge': 'Microsoft Edge',
    };

    let name = browsers[window.get_wm_class()];
    if (!name)
      return false;

    /* The bare launcher window (title == browser name) is not a PiP. */
    return window.title != name
      && !window.title.endsWith(` - ${name}`);
  }

  _checkTitle(window)
  {
    if (!window.title)
      return;

    /* Check both translated and untranslated string for
     * users that prefer running applications in English */
    let isPipWin = (window.title == 'Picture-in-Picture'
      || window.title == _('Picture-in-Picture')
      || window.title == 'Picture in picture'
      || window.title == 'Picture-in-picture'
      || window.title.endsWith(' - PiP')
      /* Telegram support */
      || window.title == 'TelegramDesktop'
      /* Yandex.Browser support YouTube */
      || window.title.endsWith(' - YouTube')
      /* Chromium Document Picture-in-Picture support (e.g. ClickUp and
       * other "pure HTML" pop-outs). Such windows keep the browser
       * wm_class but, unlike normal browser windows, their title is the
       * page title without the trailing " - <Browser>" suffix. */
      || this._isChromiumDocPip(window));

    if (isPipWin || window._isPipAble) {
      window._isPipAble = true;

      /* Only toggle state when it actually differs from the current one.
       * Re-calling make_above()/stick() unconditionally raises the window
       * on every workspace switch, which steals focus from the user. */
      let shouldBeAbove = isPipWin;
      if (shouldBeAbove && !window.above)
        window.make_above();
      else if (!shouldBeAbove && window.above)
        window.unmake_above();

      /* Change stick if enabled or unstick PipAble windows */
      let shouldStick = isPipWin && this.settings.get_boolean('stick');
      if (shouldStick && !window.on_all_workspaces)
        window.stick();
      else if (!shouldStick && window.on_all_workspaces)
        window.unstick();
    }
  }
}
