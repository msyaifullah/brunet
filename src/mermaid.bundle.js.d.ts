interface MermaidInstance {
	initialize(config: object): void;
	render(id: string, source: string): Promise<{ svg: string }>;
}

declare const mermaid: MermaidInstance;
export default mermaid;
