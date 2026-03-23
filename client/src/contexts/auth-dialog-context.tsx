import { createContext, useContext } from "react";

interface AuthDialogContextValue {
  openSignIn: () => void;
}

export const AuthDialogContext = createContext<AuthDialogContextValue>({
  openSignIn: () => {},
});

export function useSignInDialog() {
  return useContext(AuthDialogContext);
}
