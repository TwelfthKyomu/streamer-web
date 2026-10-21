import { fireEvent, render, screen } from "@testing-library/react";
import type * as React from "react";
import { describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/modules/auth";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: React.ComponentProps<"a"> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/modules/auth/client", () => ({
  signIn: { social: vi.fn() },
  signOut: vi.fn(),
}));

const { UserMenu } = await import("./user-menu");

function makeUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: "user-1",
    displayName: "Стример",
    avatarUrl: null,
    role: "user",
    pointsBalance: 42,
    isBanned: false,
    ...overrides,
  };
}

describe("UserMenu", () => {
  it("открывает меню по клику на аватарку", async () => {
    render(<UserMenu user={makeUser()} />);

    fireEvent.click(screen.getByLabelText("Меню профиля"));

    expect(await screen.findByText("Мой профиль")).toBeInTheDocument();
    expect(screen.getByText("Выйти")).toBeInTheDocument();
  });

  it("показывает имя пользователя в заголовке меню", async () => {
    render(<UserMenu user={makeUser({ displayName: "Другой" })} />);

    fireEvent.click(screen.getByLabelText("Меню профиля"));

    expect(await screen.findByText("Другой")).toBeInTheDocument();
  });

  it("прячет модерацию от обычного пользователя", async () => {
    render(<UserMenu user={makeUser()} />);

    fireEvent.click(screen.getByLabelText("Меню профиля"));
    await screen.findByText("Мой профиль");

    expect(screen.queryByText("Модерация")).not.toBeInTheDocument();
  });

  it("показывает модерацию модератору", async () => {
    render(<UserMenu user={makeUser({ role: "moderator" })} />);

    fireEvent.click(screen.getByLabelText("Меню профиля"));

    expect(await screen.findByText("Модерация")).toBeInTheDocument();
  });
});
