chrome.runtime.onMessage.addListener((msg, sender, res) => {
    switch (msg.service){
        case "firebase":
            handleFirebaseService(msg, res);
            return true;
    }
})

function handleFirebaseService(msg, res){
    switch (msg.subService){
        case "auth":
            break;
        case "database":
            firebase.database().ref(msg.route).get().then(snapshot => {
                let data = snapshot.val();
                console.log(data)
                res({
                    status: "success",
                    data
                })

            }).catch(e => {
                res({
                    status: "failed",
                    msg: e.message
                })
            })
            break;
    }
}
