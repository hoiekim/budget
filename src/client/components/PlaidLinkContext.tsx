import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

const PLAID_LINK_STABLE_URL = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

interface PlaidLinkHandler {
  open: () => void;
  exit: (force?: boolean) => void;
  destroy: () => void;
}

interface PlaidInstance {
  create: (config: {
    token: string;
    receivedRedirectUri?: string;
    onSuccess: (publicToken: string, metadata: PlaidLinkOnSuccessMetadata) => void;
    onExit: () => void;
  }) => PlaidLinkHandler;
}

type PlaidWindow = Window & { Plaid?: PlaidInstance };

interface PlaidConfig {
  token: string;
  receivedRedirectUri?: string;
  onSuccess: (publicToken: string, metadata: PlaidLinkOnSuccessMetadata) => void;
}

export interface PlaidLinkOnSuccessMetadata {
  institution: { name: string; institution_id: string } | null;
  accounts: Array<{
    id: string;
    name: string;
    mask: string;
    type: string;
    subtype: string;
    verification_status: string;
  }>;
  link_session_id: string;
  transfer_status?: string;
}

interface PlaidHandler {
  open: () => void;
  exit: (force?: boolean) => void;
  destroy: () => void;
}

interface PlaidLinkContextType {
  scriptLoaded: boolean;
  scriptError: Error | null;
  openLink: (config: PlaidConfig) => void;
}

const PlaidLinkContext = createContext<PlaidLinkContextType | null>(null);

interface PlaidLinkProviderProps {
  children: ReactNode;
}

export const PlaidLinkProvider = ({ children }: PlaidLinkProviderProps) => {
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [scriptError, setScriptError] = useState<Error | null>(null);
  const handlerRef = useRef<PlaidHandler | null>(null);

  // Load the Plaid script once
  useEffect(() => {
    // Check if script already exists
    const existingScript = document.querySelector(
      `script[src="${PLAID_LINK_STABLE_URL}"]`
    );
    if (existingScript) {
      // Script already loaded, check if Plaid is available
      if ((window as PlaidWindow).Plaid) {
        setScriptLoaded(true);
        return;
      }
      // Wait for existing script to load
      const onLoad = () => setScriptLoaded(true);
      const onError = () => setScriptError(new Error("Failed to load Plaid script"));
      existingScript.addEventListener("load", onLoad);
      existingScript.addEventListener("error", onError);
      return () => {
        existingScript.removeEventListener("load", onLoad);
        existingScript.removeEventListener("error", onError);
      };
    }

    const script = document.createElement("script");
    script.src = PLAID_LINK_STABLE_URL;
    script.async = true;

    script.onload = () => setScriptLoaded(true);
    script.onerror = () => setScriptError(new Error("Failed to load Plaid script"));

    document.body.appendChild(script);

    return () => {
      // Cleanup handler on unmount
      if (handlerRef.current) {
        handlerRef.current.destroy();
        handlerRef.current = null;
      }
    };
  }, []);

  const openLink = useCallback(
    (config: PlaidConfig) => {
      if (!scriptLoaded) {
        console.warn("Plaid script not yet loaded");
        return;
      }

      const Plaid = (window as PlaidWindow).Plaid;
      if (!Plaid) {
        console.error("Plaid is not available");
        return;
      }

      // Destroy existing handler before creating a new one
      if (handlerRef.current) {
        handlerRef.current.destroy();
        handlerRef.current = null;
      }

      const handler = Plaid.create({
        token: config.token,
        receivedRedirectUri: config.receivedRedirectUri,
        onSuccess: config.onSuccess,
        onExit: () => {
          // Handler will be destroyed when a new one is created or on unmount
        },
      });

      handlerRef.current = handler;
      handler.open();
    },
    [scriptLoaded]
  );

  const value: PlaidLinkContextType = {
    scriptLoaded,
    scriptError,
    openLink,
  };

  return (
    <PlaidLinkContext.Provider value={value}>{children}</PlaidLinkContext.Provider>
  );
};

export const usePlaidLinkContext = (): PlaidLinkContextType => {
  const context = useContext(PlaidLinkContext);
  if (!context) {
    throw new Error("usePlaidLinkContext must be used within a PlaidLinkProvider");
  }
  return context;
};
