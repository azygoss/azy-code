import type { Message } from "@earendil-works/pi-ai";

interface WorkerJsonEvent {
	type?: string;
	message?: Message;
}

export class WorkerOutputCollector {
	private buffer = "";
	private rawOutput = "";

	push(chunk: string): Message[] {
		this.buffer += chunk;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		return lines.flatMap((line) => this.parseLine(line));
	}

	finish(): Message[] {
		if (!this.buffer.trim()) return [];
		const line = this.buffer;
		this.buffer = "";
		return this.parseLine(line);
	}

	getRawOutput(): string {
		return this.rawOutput.trim();
	}

	private parseLine(line: string): Message[] {
		if (!line.trim()) return [];
		try {
			const event = JSON.parse(line) as WorkerJsonEvent;
			if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
				return [event.message];
			}
		} catch {
			this.rawOutput += `${line}\n`;
		}
		return [];
	}
}
