"use client";

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export const { signIn, signOut, useSession } = authClient;

export const authProviders = [
  { id: "twitch", label: "Twitch" },
  { id: "google", label: "Google" },
] as const;

export type AuthProviderId = (typeof authProviders)[number]["id"];
