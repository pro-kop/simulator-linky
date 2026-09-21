'use strict';
// Start aplikace.

refreshColors();
bindUI();
resizeCanvases();
applyTransform();
loadDemo();
updateStats();
// Po načtení fontu se mění rozměry karet → přepočítat napojení spojů.
if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawEdges);
