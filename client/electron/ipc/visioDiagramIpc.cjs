const { ipcMain, shell } = require('electron');

function registerVisioDiagramIpc({ visioDiagramStore, visioMcpService, taskService }) {
  ipcMain.handle('visio-diagram:load-state', () => visioDiagramStore.loadVisioDiagram());
  ipcMain.handle('visio-diagram:save-requirements', (_event, requirements) => visioDiagramStore.saveRequirements(requirements));
  ipcMain.handle('visio-diagram:save-plan', (_event, plan) => visioDiagramStore.savePlan(plan));
  ipcMain.handle('visio-diagram:update-step', (_event, step) => visioDiagramStore.updateVisioDiagram({ step }));
  ipcMain.handle('visio-diagram:clear', () => taskService.resetVisioDiagram());

  ipcMain.handle('visio-diagram:get-component-status', () => visioMcpService.getStatus());
  ipcMain.handle('visio-diagram:run-component-self-check', () => visioMcpService.runSelfCheck());
  ipcMain.handle('visio-diagram:restart-component', () => visioMcpService.restart());

  ipcMain.handle('visio-diagram:open-artifact', async (_event, relativePath) => {
    const targetPath = visioDiagramStore.resolveArtifactPath(relativePath);
    const errorMessage = await shell.openPath(targetPath);
    if (errorMessage) {
      throw new Error(`打开 Visio 产物失败：${errorMessage}`);
    }
    return { success: true };
  });
}

module.exports = {
  registerVisioDiagramIpc,
};