import {
  dialogTitleSource,
  normalizeGeneratedTitle,
  provisionalDialogTitle,
} from "../src/dialog-title.js";

describe("dialog titles", () => {
  it("extracts the actual user message from injected context", () => {
    expect(dialogTitleSource([
      "[Внутренние события Коди]",
      "Диск почти заполнен",
      "",
      "[Сообщение пользователя]",
      "сделай меню диалогов",
    ].join("\n"))).toBe("сделай меню диалогов");
  });

  it("builds a readable provisional title", () => {
    expect(provisionalDialogTitle("сделай меню диалогов для телеграма")).toBe("Сделай меню диалогов");
  });

  it("accepts only a clean two or three word Spark response", () => {
    expect(normalizeGeneratedTitle("Меню диалогов Коди\n")).toBe("Меню диалогов Коди");
    expect(normalizeGeneratedTitle("Вот название: Меню диалогов Коди")).toBeNull();
    expect(normalizeGeneratedTitle("Диалоги")).toBeNull();
  });
});
