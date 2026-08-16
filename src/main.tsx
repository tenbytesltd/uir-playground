import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PlaygroundLab } from "./PlaygroundLab.tsx";
import { examplePackage } from "./example.ts";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PlaygroundLab initialPackage={examplePackage} />
  </StrictMode>,
);
