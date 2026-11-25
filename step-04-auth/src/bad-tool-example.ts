export const badToolExample = {
  name: "doThing",
  description: "",
  inputSchema: {
    text: "string",
  },
  handler: async ({ text }: { text: string }) => ({
    content: [{ type: "text" as const, text }],
  }),
};
