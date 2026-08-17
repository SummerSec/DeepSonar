import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth";
import { ConfirmDialogProvider } from "./components/ConfirmDialog";
import { ToastHost } from "./toast";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ConfirmDialogProvider>
          <App />
          <ToastHost />
        </ConfirmDialogProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
