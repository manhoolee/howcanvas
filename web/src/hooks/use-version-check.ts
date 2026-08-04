import { useCallback, useMemo, useState } from "react";
import { App } from "antd";
import { APP_VERSION } from "@/constant/env";
import type { ReleaseInfo } from "@/lib/release";

function readLocalReleases(): ReleaseInfo[] {
    return __APP_RELEASES__ || [];
}

export function useVersionCheck() {
    const currentVersion = APP_VERSION;
    const { message } = App.useApp();
    const localReleases = useMemo(readLocalReleases, []);
    const [latestVersion, setLatestVersion] = useState(currentVersion);
    const [releases, setReleases] = useState<ReleaseInfo[]>(localReleases);
    const [open, setOpen] = useState(false);
    const checking = false;
    const hasNewVersion = false;

    const checkLatestRelease = useCallback(
        async (showMessage = false) => {
            setLatestVersion(currentVersion);
            setReleases(localReleases);
            if (showMessage) message.success("已读取当前版本信息");
            return true;
        },
        [currentVersion, localReleases, message],
    );

    const openReleaseModal = useCallback(() => {
        setOpen(true);
    }, []);

    return {
        open,
        setOpen,
        openReleaseModal,
        latestVersion,
        releases,
        checking,
        hasNewVersion,
        checkLatestRelease,
    };
}
