import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./layout/AppShell";
import { DashboardPage } from "./pages/DashboardPage";
import { FindingsPage } from "./pages/FindingsPage";
import { JobsPage } from "./pages/JobsPage";
import { ProjectLayout } from "./pages/ProjectLayout";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TaskCanvasPage } from "./pages/TaskCanvasPage";
import { TasksPage } from "./pages/TasksPage";

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="findings" element={<FindingsPage scope="global" />} />

        <Route path="projects/:projectId" element={<ProjectLayout />}>
          <Route index element={<Navigate to="tasks" replace />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="tasks/:canvasId" element={<TaskCanvasPage />} />
          <Route path="findings" element={<FindingsPage scope="project" />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
