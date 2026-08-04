import { lazy, Suspense } from "react";
import { Spin } from "antd";
import { createBrowserRouter, Outlet } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import { RequireAdmin, RequireAuth, RequirePermission } from "@/components/auth/guards";
import UserLayout from "@/layouts/user-layout";

const AccountPage = lazy(() => import("@/pages/account"));
const AdminPage = lazy(() => import("@/pages/admin"));
const AssetsPage = lazy(() => import("@/pages/assets"));
const AuthPage = lazy(() => import("@/pages/auth"));
const CanvasPage = lazy(() => import("@/pages/canvas"));
const CanvasProjectPage = lazy(() => import("@/pages/canvas/project"));
const ConfigPage = lazy(() => import("@/pages/config"));
const HomePage = lazy(() => import("@/pages/home"));
const ImagePage = lazy(() => import("@/pages/image"));
const NotFound = lazy(() => import("@/pages/not-found"));
const PromptsPage = lazy(() => import("@/pages/prompts"));
const PublicAssetsPage = lazy(() => import("@/pages/public-assets"));
const VideoPage = lazy(() => import("@/pages/video"));

function RouteLoader() {
    return <div className="flex h-full min-h-48 w-full items-center justify-center"><Spin size="large" /></div>;
}

function LazyRouteOutlet() {
    return <Suspense fallback={<RouteLoader />}><Outlet /></Suspense>;
}

export const router = createBrowserRouter([
    { path: "/login", element: <Suspense fallback={<RouteLoader />}><AuthPage /></Suspense> },
    {
        element: (
            <RequireAuth>
                <UserLayout>
                    <AnalyticsTracker />
                    <LazyRouteOutlet />
                </UserLayout>
            </RequireAuth>
        ),
        children: [
            { path: "/", element: <HomePage /> },
            { path: "/image", element: <RequirePermission perm="image"><ImagePage /></RequirePermission> },
            { path: "/video", element: <RequirePermission perm="video"><VideoPage /></RequirePermission> },
            { path: "/assets", element: <RequirePermission perm="assets"><AssetsPage /></RequirePermission> },
            { path: "/public-assets", element: <PublicAssetsPage /> },
            { path: "/prompts", element: <RequirePermission perm="prompts"><PromptsPage /></RequirePermission> },
            { path: "/canvas", element: <RequirePermission perm="canvas"><CanvasPage /></RequirePermission> },
            { path: "/canvas/:id", element: <RequirePermission perm="canvas"><CanvasProjectPage /></RequirePermission> },
            { path: "/config", element: <RequireAdmin><ConfigPage /></RequireAdmin> },
            { path: "/account", element: <AccountPage /> },
            { path: "/admin", element: <RequireAdmin><AdminPage /></RequireAdmin> },
        ],
    },
    { path: "*", element: <Suspense fallback={<RouteLoader />}><NotFound /></Suspense> },
]);
