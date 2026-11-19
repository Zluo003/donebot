type TextKind = "assistant_text" | "reasoning_text";
const ENVELOPES = [
  { open: "<think>", close: "</think>" },
  { open: "<thinking>", close: "</thinking>" },
];

export class TaggedReasoning {
  private buffer = "";
  private close = "";
  private answer = false;
  private readonly emit: (text: string, kind: TextKind) => void;

  constructor(emit: (text: string, kind: TextKind) => void) { this.emit = emit; }

  write(text: string): void {
    if (this.answer) { this.emit(text, "assistant_text"); return; }
    this.buffer += text;
    while (this.buffer) {
      if (this.close) {
        const end = this.buffer.indexOf(this.close);
        if (end >= 0) {
          this.emit(this.buffer.slice(0, end), "reasoning_text");
          this.buffer = this.buffer.slice(end + this.close.length);
          this.close = "";
          continue;
        }
        let retained = Math.min(this.buffer.length, this.close.length - 1);
        while (retained && !this.close.startsWith(this.buffer.slice(-retained))) retained--;
        this.emit(this.buffer.slice(0, this.buffer.length - retained), "reasoning_text");
        this.buffer = retained ? this.buffer.slice(-retained) : "";
        return;
      }
      const prefix = this.buffer.trimStart();
      const envelope = ENVELOPES.find(({ open }) => prefix.startsWith(open));
      if (envelope) {
        this.close = envelope.close;
        this.buffer = prefix.slice(envelope.open.length);
        continue;
      }
      if (ENVELOPES.some(({ open }) => open.startsWith(prefix))) return;
      this.answer = true;
      this.emit(this.buffer, "assistant_text");
      this.buffer = "";
    }
  }

  end(): void {
    this.emit(this.buffer, this.close ? "reasoning_text" : "assistant_text");
    this.buffer = "";
  }
}
