#!/usr/bin/env node
import { runSummaryRegistryCommand } from "../commands/summary-registry.js";

process.exitCode = runSummaryRegistryCommand(process.argv.slice(2));
