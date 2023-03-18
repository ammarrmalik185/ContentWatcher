const config = {
    skippablePath: "public/skippableContent/" + domain.hostname.replaceAll(".", "_") + "/" + domain.searchParams.get("v"),
    isVideoPage: domain.pathname.includes("/watch?v="),
    findPlayer: () => {
        return document.getElementsByTagName("video")[0];
    }
}
