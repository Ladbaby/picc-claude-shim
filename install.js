#!/usr/bin/env node

import { runInstaller } from "./installer-lib.mjs";

process.exitCode = runInstaller() ? 0 : 1;
