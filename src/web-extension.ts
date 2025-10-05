// This file and activateRomLuaDebug.ts forms the "plugin" that plugs into VS Code and contains the code 
// that connects VS Code with the debug adapter.
// Launches the debug adapter "inlined" because that's the only supported mode for running the debug adapter in the browser.

import * as vscode from 'vscode';
import { activateRomLuaDebug } from './activateRomLuaDebug';

export function activate(context: vscode.ExtensionContext) {
	activateRomLuaDebug(context);
}

export function deactivate() {
	// nothing to do
}
