import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { RequireAuth } from "./auth";
import { AppShell } from "./layout/AppShell";
import { PageSkeleton } from "./ui";

const AgentsPage = lazy(() => import("./pages/AgentsPage").then((module) => ({ default: module.AgentsPage })));
const AgentMarketplacePage = lazy(() => import("./pages/AgentMarketplacePage").then((module) => ({ default: module.AgentMarketplacePage })));
const DashboardPage = lazy(() => import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const FindingsPage = lazy(() => import("./pages/FindingsPage").then((module) => ({ default: module.FindingsPage })));
const JobsPage = lazy(() => import("./pages/JobsPage").then((module) => ({ default: module.JobsPage })));
const ProjectLayout = lazy(() => import("./pages/ProjectLayout").then((module) => ({ default: module.ProjectLayout })));
const ProjectsPage = lazy(() => import("./pages/ProjectsPage").then((module) => ({ default: module.ProjectsPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const ProjectDataPage = lazy(() => import("./pages/ProjectDataPage").then((module) => ({ default: module.ProjectDataPage })));
const ProjectUsagePage = lazy(() => import("./pages/ProjectUsagePage").then((module) => ({ default: module.ProjectUsagePage })));
const TaskCanvasRoute = lazy(() => import("./pages/TaskCanvasRoute").then((module) => ({ default: module.TaskCanvasRoute })));
const TasksPage = lazy(() => import("./pages/TasksPage").then((module) => ({ default: module.TasksPage })));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage").then((module) => ({ default: module.NotFoundPage })));
const LoginPage = lazy(() => import("./pages/LoginPage").then((module) => ({ default: module.LoginPage })));
const RuntimeImagesPage = lazy(() => import("./pages/RuntimeImagesPage").then((module) => ({ default: module.RuntimeImagesPage })));
const PlatformSettingsPage = lazy(() => import("./pages/PlatformSettingsPage").then((module) => ({ default: module.PlatformSettingsPage })));

function Deferred({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageSkeleton />}>{children}</Suspense>;
}

export default function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <Deferred>
            <LoginPage />
          </Deferred>
        }
      />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route
          index
          element={
            <Deferred>
              <DashboardPage />
            </Deferred>
          }
        />
        <Route
          path="projects"
          element={
            <Deferred>
              <ProjectsPage />
            </Deferred>
          }
        />
        <Route
          path="jobs"
          element={
            <Deferred>
              <JobsPage />
            </Deferred>
          }
        />
        <Route
          path="findings"
          element={
            <Deferred>
              <FindingsPage scope="global" />
            </Deferred>
          }
        />
        <Route
          path="agents"
          element={
            <Deferred>
              <AgentsPage />
            </Deferred>
          }
        />
        <Route
          path="agent-market"
          element={
            <Deferred>
              <AgentMarketplacePage />
            </Deferred>
          }
        />
        <Route
          path="images"
          element={
            <Deferred>
              <RuntimeImagesPage />
            </Deferred>
          }
        />
        <Route path="settings" element={<Navigate to="/settings/access" replace />} />
        <Route
          path="settings/:section"
          element={
            <Deferred>
              <PlatformSettingsPage />
            </Deferred>
          }
        />
        <Route
          path="projects/:projectId"
          element={
            <Deferred>
              <ProjectLayout />
            </Deferred>
          }
        >
          <Route index element={<Navigate to="tasks" replace />} />
          <Route
            path="tasks"
            element={
              <Deferred>
                <TasksPage />
              </Deferred>
            }
          />
          <Route
            path="tasks/:canvasId"
            element={
              <Deferred>
                <TaskCanvasRoute />
              </Deferred>
            }
          />
          <Route
            path="findings"
            element={
              <Deferred>
                <FindingsPage scope="project" />
              </Deferred>
            }
          />
          <Route
            path="usage"
            element={
              <Deferred>
                <ProjectUsagePage />
              </Deferred>
            }
          />
          <Route
            path="data"
            element={
              <Deferred>
                <ProjectDataPage />
              </Deferred>
            }
          />
          <Route
            path="settings"
            element={
              <Deferred>
                <SettingsPage />
              </Deferred>
            }
          />
          <Route
            path="images"
            element={
              <Deferred>
                <RuntimeImagesPage />
              </Deferred>
            }
          />
        </Route>
        <Route
          path="*"
          element={
            <Deferred>
              <NotFoundPage />
            </Deferred>
          }
        />
      </Route>
    </Routes>
  );
}
