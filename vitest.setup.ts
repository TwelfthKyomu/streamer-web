import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Без globals: true авто-очистка testing-library не подключается сама,
// иначе разметка предыдущего теста остаётся в документе.
afterEach(() => {
  cleanup();
});
