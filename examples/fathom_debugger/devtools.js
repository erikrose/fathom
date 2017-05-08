browser.devtools.panels.create(
  "Fathom",
  "icon.png",
  "devtools-panel.html"
).then((newPanel) => {
  newPanel.onShown.addListener(showPanel);
  newPanel.onHidden.addListener(hidePanel);
});

function showPanel() {
    console.log("panel is being shown");
}
function hidePanel() {
    console.log("panel is being hidden");
}
