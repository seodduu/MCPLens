#!/usr/bin/env node

import { runHookCapture } from '../runtime/hook-capture.mjs';

await runHookCapture('codex');
