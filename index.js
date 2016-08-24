const self = require('sdk/self');
const asyncStorage = require("lib/async-storage");
const profiler = require("lib/profiler");
const symbolStore = require("lib/symbol-store");
const { Hotkey } = require("sdk/hotkeys");
const tabs = require("sdk/tabs");
const { viewFor } = require("sdk/view/core");
const { getBrowserForTab } = require("sdk/tabs/utils");
const { prefs } = require("sdk/simple-prefs");
const { setTimeout } = require("sdk/timers");
const notifications = require("sdk/notifications");

// a dummy function, to show how tests work.
// to see how to test this function, look at test/test-index.js
function dummy(text, callback) {
  asyncStorage.setItem("dummytext", text).then(() => {
    return asyncStorage.getItem("dummytext");
  }).then(callback);
}

function getNSSSymbols() {
  return profiler.getSharedLibraryInformation().then(libs => {
    let loadedNSSLibs = libs.filter(lib => {
      return lib.pdbName.toLowerCase().startsWith("libnss3");
    });
    return Promise.all(loadedNSSLibs.map(lib => {
      return symbolStore.getSymbols(lib.pdbName, lib.breakpadId, lib.name,
                                    profiler.platform.platform,
                                    profiler.platform.arch);
    }));
  });
}

let settings = {
  entries: 10000000,
  interval: 0.1,
  features: ["stackwalk", "threads", "leaf"],
  threads: ["GeckoMain"]
}

/**
 * Parsing:
 * https://dxr.mozilla.org/mozilla-central/source/devtools/shared/specs/profiler.js#
 */
let isCollecting = false;
function startProfiler() {
  notifications.notify({
    title: "Profiler started!"
  });
  return profiler.start(
    settings.entries,
    settings.interval,
    settings.features,
    settings.threads
  );
}

function restartProfiler() {
  if (isCollecting) {
    return;
  }
  profiler.isRunning().then((running) => {
    if (!running) {
      return null;
    }
    return profiler.stop();
  })
  .then(() => setTimeout(startProfiler, 1));
}

function toggleProfilerStartStop() {
  profiler.isRunning().then(running => {
    if (running) {
      notifications.notify({
        title: "Stopped Profiler"
      });
      profiler.stop();
    } else {
      startProfiler();
    }
  })
}

function makeProfileAvailableToTab(profile, url, tab) {
  const browser = getBrowserForTab(viewFor(tab));
  const mm = browser.messageManager;
  mm.loadFrameScript(self.data.url('cleopatra-tab-framescript.js'), true);
  mm.sendAsyncMessage("Cleopatra:Init", {profile, url});
  mm.addMessageListener('Cleopatra:GetSymbolTable', e => {
    const { pdbName, breakpadId } = e.data;
    symbolStore.getSymbols(pdbName, breakpadId).then(result => {
      const [addr, index, buffer] = result;
      mm.sendAsyncMessage('Cleopatra:GetSymbolTableReply', {
        status: 'success',
        pdbName, breakpadId, result: [addr, index, buffer]
      });
    }, error => {
      mm.sendAsyncMessage('Cleopatra:GetSymbolTableReply', {
        status: 'error',
        pdbName, breakpadId, error
      });
    })
  });
}

function collectProfile() {
  isCollecting = true;
  console.log("Getting profile");
  const url = tabs.activeTab.url;
  profiler.getProfile().then((profile) => {
    isCollecting = false;
    profiler.stop();
    var tabOpenPromise = new Promise((resolve, reject) => {
      tabs.open({
        url: prefs.reportUrl,
        onReady: resolve
      });
    });
    var symbolStorePrimingPromise = profiler.getSharedLibraryInformation()
      .then(sli => symbolStore.prime(sli, profiler.platform));
    return Promise.all([
      profile,
      tabOpenPromise,
      symbolStorePrimingPromise
    ]);
  })
  .then((([profile, tab]) => {
    return makeProfileAvailableToTab(profile, url, tab);
  }))
  .catch(error => {
    console.log("Error getting profile:", error.message);
  });
}

tabs.on('open', (tab) => {
  restartProfiler();
});

let autoProfile = true;
tabs.on('load', (tab) => {
  if (!autoProfile) {
    return;
  }
  if (!tab.url.startsWith("http")) {
    return;
  }
  if (tab.url.startsWith(prefs.reportUrl)) {
    return;
  }
  setTimeout(collectProfile, 1000);
});
function toggleAutoProfile() {
  const state = autoProfile ? "Disabled" : "Enabled";
  notifications.notify({
    title: `${state} auto profiling page load`
  });
  autoProfile = !autoProfile;
}

let startStopHotKey = Hotkey({
  combo: "control-shift-5",
  onPress: toggleProfilerStartStop
});

let collectHotKey = Hotkey({
  combo: "control-shift-6",
  onPress: collectProfile
});

let toggleLoadHotKey = Hotkey({
  combo: "control-shift-7",
  onPress: toggleAutoProfile
});

function main(options, callbacks) {
  startProfiler();
}

exports.getNSSSymbols = getNSSSymbols;
exports.main = main;
