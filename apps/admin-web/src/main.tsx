import React from "react";
import ReactDOM from "react-dom/client";

import App from "./app/App";

import "./styles/variables.css";
import "./styles/globals.css";
import "./styles/cards.css";
import "./styles/tables.css";
import "./styles/buttons.css";
import "./styles/badges.css";
import "./styles/forms.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);