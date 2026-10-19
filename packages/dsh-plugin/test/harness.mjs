// Compatibility regression fixture only. Production uses HostServices inside DSH.
import { HostServices } from '../src/host/services.mjs';
import { DshBackend } from '../../../apps/desktop/src/host/dsh.mjs';
import { Capabilities } from '../../../apps/desktop/src/native/capabilities.mjs';
import { runLegacy } from '../src/host/legacy-run.mjs';
export class Engine extends HostServices {
  constructor(directory, onChange = () => {}, runModel) {
    super(directory, { dsh: new DshBackend(directory), capabilities: {}, onChange, runModel });
    this.dsh.run = runLegacy;
    this.capabilities = new Capabilities(this);
    this.dsh.beforeStart = () => this.capabilities.start();
  }
  async close() { try { await super.close(); } finally { await this.dsh.close(); } }
}
