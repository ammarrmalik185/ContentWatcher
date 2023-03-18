const firebaseConfig = {
    apiKey: "AIzaSyAjMLblgkd0HXGOKI7S1L0r94o4uZ0HoFI",
    authDomain: "contentwatcherx.firebaseapp.com",
    databaseURL: "https://contentwatcherx-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "contentwatcherx",
    storageBucket: "contentwatcherx.appspot.com",
    messagingSenderId: "409569575345",
    appId: "1:409569575345:web:537fccae09c51425533d90"
};

// Initialize Firebase
try{
    let app = firebase.initializeApp(firebaseConfig);
}catch (e){
    console.log("init again")
}
