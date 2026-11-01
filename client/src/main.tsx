import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/hooks/use-theme";
import { AuthProvider } from "@/hooks/use-auth";
import { ToastProvider } from "@/components/ui/toast";
import { ColdStartOverlay } from "@/components/cold-start-overlay";
import { ServerStatusProvider, consumeSwitchStamp } from "@/hooks/use-server-status";
import { ServerStatusBanner } from "@/components/pwa/server-status-banner";
import { UpdatePrompt } from "@/components/pwa/update-prompt";
import { queryClient } from "@/lib/query-client";
import App from "@/App";
import "@/index.css";

consumeSwitchStamp();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <ServerStatusProvider>
            <AuthProvider>
              <ColdStartOverlay />
              <ServerStatusBanner />
              <UpdatePrompt />
              <App />
            </AuthProvider>
          </ServerStatusProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
