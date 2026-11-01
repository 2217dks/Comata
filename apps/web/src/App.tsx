import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Dashboard } from "./pages/Dashboard";
import { NotebookPage } from "./pages/NotebookPage";
import { AiAdminPage } from "./pages/AiAdminPage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/notebook/:id" element={<NotebookPage />} />
        <Route path="/ai-admin" element={<AiAdminPage />} />
      </Routes>
    </BrowserRouter>
  );
}
