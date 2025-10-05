import {
	LoggingDebugSession,
	InitializedEvent, StoppedEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint,
	ContinuedEvent
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as net from 'net';

const COMMANDS = {
	BP_ADD: 1,
	BP_CLEAR_FILE: 2,
	CONTINUE: 3,
	STEP_IN: 4,
	STEP_OUT: 5,
	STEP_NEXT: 6,
};

const RESPONSES = {
	STOP: 100,
	CONTINUED: 104,
};

class NetBuffer {
	private data: number[] = [];
	private readCursor: number = 0;

	from(data: Buffer) {
		this.data = Array.from(data.values());
	}

	writeByte(b: number): void {
		this.data.push(b & 0xFF);
	}

	writeShort(s: number): void {
		this.data.push((s >> 8) & 0xFF);
		this.data.push(s & 0xFF);
	}

	writeInt(i: number): void {
		this.data.push((i >> 24) & 0xFF);
		this.data.push((i >> 16) & 0xFF);
		this.data.push((i >> 8) & 0xFF);
		this.data.push(i & 0xFF);
	}

	writeString(s: string): void {
		const bytes = Array.from(new TextEncoder().encode(s));

		this.writeShort(bytes.length);

		this.data.push(...bytes);
	}

	send(socket: net.Socket | undefined) {
		if (!socket) {
			console.warn("Socket is not connected.");
			return;
		}

		socket.write(this.prepareSendBuffer());
	}

	readByte(): number {
		if (this.readCursor >= this.data.length) throw new Error("Buffer underflow");
		return this.data[this.readCursor++];
	}

	readShort(): number {
		const b1 = this.readByte();
		const b2 = this.readByte();
		return (b1 << 8) | b2;
	}

	readInt(): number {
		const b1 = this.readByte();
		const b2 = this.readByte();
		const b3 = this.readByte();
		const b4 = this.readByte();

		return (b1 << 24) | (b2 << 16) | (b3 << 8) | b4;
	}

	readString(): string {
		const length = this.readShort();

		const bytes = this.data.slice(this.readCursor, this.readCursor + length);
		this.readCursor += length;

		return new TextDecoder().decode(new Uint8Array(bytes));
	}

	prepareSendBuffer(): Uint8Array {
		const payload = new Uint8Array(this.data);
		const length = payload.length;

		const length_prefix_length = 4;
		const header = new Uint8Array(length_prefix_length);
		new DataView(header.buffer).setUint32(0, length, false);

		const full = new Uint8Array(header.length + payload.length);
		full.set(header, 0);
		full.set(payload, header.length);

		console.log("Sending:", Array.from(full).map(b => b.toString(16).padStart(2, '0')).join(' '));
		return full;
	}

}

function commandsToString(cmd: number): string {
	switch (cmd) {
		case COMMANDS.BP_ADD: return "BP_ADD";
		case COMMANDS.BP_CLEAR_FILE: return "BP_CLEAR_FILE";
		case COMMANDS.CONTINUE: return "CONTINUE";
		case COMMANDS.STEP_IN: return "STEP_IN";
		case COMMANDS.STEP_OUT: return "STEP_OUT";
		case COMMANDS.STEP_NEXT: return "STEP_NEXT";
		default: return "UNKNOWN";
	}
}

function responsesToString(resp: number): string {
	switch (resp) {
		case RESPONSES.STOP: return "STOP";
		case RESPONSES.CONTINUED: return "CONTINUED";
		default: return "UNKNOWN";
	}
}

export class RomLuaDebugSession extends LoggingDebugSession {

	private static THREAD_ID = 1;

	private socket?: net.Socket;
	private recvBuffer: Buffer = Buffer.alloc(0);  // persistent accumulator
	private breakpoints: Map<string, Map<number, DebugProtocol.Breakpoint>> = new Map();

	private variableHandles = new Handles<string>();
	private localsHandle: number | undefined;
	private globalsHandle: number | undefined;

	private sourceFile = "";
	private lastStoppedLine: number = 1;
	private lastStoppedFuncName: string = "";
	private locals: Record<string, string> = {};
	private globals: Record<string, string> = {};

	public constructor() {
		super("rom-lua-debugger.txt");
	}

	protected initializeRequest(
		response: DebugProtocol.InitializeResponse,
		args: DebugProtocol.InitializeRequestArguments
	): void {
		response.body = response.body || {};
		response.body.supportsConfigurationDoneRequest = true;
		response.body.supportsEvaluateForHovers = true;
		response.body.supportsStepBack = false;
		response.body.supportsDataBreakpoints = false;
		response.body.supportsCancelRequest = false;
		response.body.supportsTerminateRequest = true;

		this.sendResponse(response);
		this.sendEvent(new InitializedEvent());
	}

	protected async launchRequest(
		response: DebugProtocol.LaunchResponse,
		args: any
	): Promise<void> {
		this.sourceFile = args.program;
		this.startSocket();
		this.sendResponse(response);
	}

	private startSocket() {
		let address = "127.0.0.1";
		let port = 4712;
		console.log(`Connecting to Lua debugger on ${address}:${port}...`);
		this.socket = net.createConnection({ host: address, port: port }, () => {
			console.log(`Connected to Lua debugger on ${address}:${port}...`);
		});

		this.socket.on("data", (data: Buffer) => {
			// Append new chunk
			this.recvBuffer = Buffer.concat([this.recvBuffer, data]);

			while (this.recvBuffer.length >= 4) {
				const len = this.recvBuffer.readUInt32BE(0);
				console.log("packet length: ", len)

				// Wait for the full payload
				if (this.recvBuffer.length < 4 + len) break;

				// Extract one packet
				const packet = this.recvBuffer.slice(4, 4 + len);

				// Shrink buffer
				this.recvBuffer = this.recvBuffer.slice(4 + len);

				// Parse with NetBuffer
				let buffer = new NetBuffer();
				buffer.from(packet);   // 'packet' is the payload bytes only

				console.log("about to handleSocketMessage")
				this.handleSocketMessage(buffer);
			}
		});
	}

	private handleSocketMessage(buffer: NetBuffer) {
		const id = buffer.readByte();

		console.log("Received from Lua:", responsesToString(id));

		switch (id) {
			case RESPONSES.STOP:
				console.log("reading file");
				let file = buffer.readString();
				console.log("reading line");
				let line = buffer.readInt();
				console.log("reading funcName");
				let funcName = buffer.readString();

				let localCount = buffer.readInt();
				console.log("reading localCount", localCount);
				let locals: Record<string, string> = {};
				for (let i = 0; i < localCount; i++) {
					let name = buffer.readString();
					let value = buffer.readString();
					locals[name] = value;
				}
				console.log("done reading localCount", localCount);

				let globalCount = buffer.readInt();
				console.log("reading globalCount", globalCount);
				let globals: Record<string, string> = {};
				for (let i = 0; i < globalCount; i++) {
					let name = buffer.readString();
					let value = buffer.readString();
					globals[name] = value;
				}

				console.log("done reading globalCount", globalCount);

				// Store for stackTraceRequest, variablesRequest...
				this.sourceFile = file;
				this.lastStoppedLine = line;
				this.lastStoppedFuncName = funcName;
				this.locals = locals;
				this.globals = globals;

				console.log("stop handler: ", this.locals);
				console.log("stop handler: ", this.globals);

				this.sendEvent(new StoppedEvent("breakpoint", RomLuaDebugSession.THREAD_ID));
				break;
			case RESPONSES.CONTINUED:
				console.log("Continued execution");
				this.sendEvent(new ContinuedEvent(RomLuaDebugSession.THREAD_ID));
				break;
			default:
				console.warn("Unknown response from Lua:", buffer.prepareSendBuffer());
				break;
		}
	}

	protected setBreakPointsRequest(
		response: DebugProtocol.SetBreakpointsResponse,
		args: DebugProtocol.SetBreakpointsArguments
	): void {
		const path = args.source.path!;
		const clientLines = args.lines || [];

		// Clear breakpoints on the Lua side
		let buffer = new NetBuffer();
		buffer.writeByte(COMMANDS.BP_CLEAR_FILE);
		buffer.writeString(path);
		buffer.send(this.socket);

		const actualBreakpoints: DebugProtocol.Breakpoint[] = [];
		this.breakpoints.set(path, new Map());

		for (const line of clientLines) {
			const bpLine = line; // Use 1-to-1 mapping for now

			let buffer = new NetBuffer();
			buffer.writeByte(COMMANDS.BP_ADD);
			buffer.writeString(path);
			buffer.writeInt(bpLine);
			buffer.send(this.socket);

			// Keep track locally
			const bp = new Breakpoint(true, bpLine);
			actualBreakpoints.push(bp);
			this.breakpoints.get(path)!.set(bpLine, bp);
		}

		response.body = { breakpoints: actualBreakpoints };
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		response.body = {
			threads: [new Thread(RomLuaDebugSession.THREAD_ID, "thread 1")]
		};

		this.sendResponse(response);
	}

	protected stackTraceRequest(
		response: DebugProtocol.StackTraceResponse,
		args: DebugProtocol.StackTraceArguments
	): void {
		const frame: DebugProtocol.StackFrame = {
			id: 1,
			name: this.lastStoppedFuncName || "<unknown>",
			source: {
				path: this.sourceFile
			},
			line: this.lastStoppedLine,
			column: 1
		};

		response.body = {
			stackFrames: [frame],
			totalFrames: 1
		};

		this.sendResponse(response);
	}

	// Scopes request; 
	// value of command field is 'scopes'. 
	// The request returns the variable scopes for a given stackframe ID.
	protected scopesRequest(
		response: DebugProtocol.ScopesResponse,
		args: DebugProtocol.ScopesArguments
	): void {
		// Initialize handles once
		if (this.localsHandle == undefined) this.localsHandle = this.variableHandles.create("locals");
		if (this.globalsHandle == undefined) this.globalsHandle = this.variableHandles.create("globals");

		response.body = {
			scopes: [
				new Scope("Locals", this.localsHandle, true),
				new Scope("Globals", this.globalsHandle, true)
			]
		};
		this.sendResponse(response);
	}

	// Variables request; value of command field is 'variables'. 
	// Retrieves all child variables for the given variable reference. 
	// An optional filter can be used to limit the fetched children to either named or indexed children.
	protected variablesRequest(
		response: DebugProtocol.VariablesResponse,
		args: DebugProtocol.VariablesArguments
	): void {
		const scope = this.variableHandles.get(args.variablesReference);
		let variables: DebugProtocol.Variable[] = [];

		if (scope === "locals") {
			console.log("Local scope variablesRequest");
			variables = Object.entries(this.locals).map(([name, value]) => ({
				name,
				value: String(value),
				variablesReference: 0 // leaf node
			}));
		} else if (scope === "globals") {
			console.log("Global scope variablesRequest");
			variables = Object.entries(this.globals).map(([name, value]) => ({
				name,
				value: String(value),
				variablesReference: 0
			}));
		} else {
			console.warn("Unknown scope for handle:", args.variablesReference);
		}

		response.body = { variables };
		this.sendResponse(response);
	}

	protected continueRequest(
		response: DebugProtocol.ContinueResponse,
		args: DebugProtocol.ContinueArguments
	): void {
		let buffer = new NetBuffer();
		buffer.writeByte(COMMANDS.CONTINUE);
		buffer.send(this.socket);

		this.sendResponse(response);
	}

	protected nextRequest(
		response: DebugProtocol.NextResponse,
		args: DebugProtocol.NextArguments
	): void {
		let buffer = new NetBuffer();
		buffer.writeByte(COMMANDS.STEP_NEXT);
		buffer.send(this.socket);

		this.sendResponse(response);
	}

	protected stepInRequest(
		response: DebugProtocol.StepInResponse,
		args: DebugProtocol.StepInArguments
	): void {
		let buffer = new NetBuffer();
		buffer.writeByte(COMMANDS.STEP_IN);
		buffer.send(this.socket);

		this.sendResponse(response);
	}

	protected stepOutRequest(
		response: DebugProtocol.StepOutResponse,
		args: DebugProtocol.StepOutArguments
	): void {
		let buffer = new NetBuffer();
		buffer.writeByte(COMMANDS.STEP_OUT);
		buffer.send(this.socket);

		this.sendResponse(response);
	}
}
