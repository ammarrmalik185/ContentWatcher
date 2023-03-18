console.log("Extension Here")

let skipInfos = []
let video = config.findPlayer();
let autoSkip = true;
let domain = new URL(window.location);

chrome.runtime.sendMessage({
    service: "firebase",
    subService: "database",
    route: config.skippablePath
}, res => {
    console.log(res)
    skipInfos = res.data;
})

function detectSkip(){
    let time = video.currentTime;
    for (const timeRange of skipInfos) {
        if(time > timeRange.start && time < timeRange.end) return timeRange.end;
    }
    return null;
}

video.addEventListener("timeupdate", () => {
    console.log("Video time:" + video.currentTime)

    let skip = detectSkip();
    console.log(skip)
    if(skip && autoSkip){
        video.currentTime = skip;
    }
})


