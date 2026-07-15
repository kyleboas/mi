#!/usr/bin/env node
/** Remove only temporary Mi eval entries from the non-secret Pi registry. */
import { uninstallEvalModels } from './install-mi-model-eval-models.mjs';

uninstallEvalModels()
  .then((result) => console.log(result.changed ? 'removed temporary user-level eval aliases' : 'user-level eval aliases already absent'))
  .catch((error) => { console.error(`eval model registry restore: ${error.message}`); process.exitCode = 1; });
