import { escapeHTML } from "../src/format.js";

describe("escapeHTML", () => {
  it("escapes HTML entities", () => {
    expect(escapeHTML("<div>& hi ></div>")).toBe("&lt;div&gt;&amp; hi &gt;&lt;/div&gt;");
  });

  it("leaves plain text and double quotes unchanged", () => {
    expect(escapeHTML('say "hello"')).toBe('say "hello"');
  });
});
