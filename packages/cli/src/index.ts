#!/usr/bin/env bun
import { run } from "./cli.ts";

process.exit(await run(process.argv.slice(2)));
