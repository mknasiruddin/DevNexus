const express = require("express");

const app = express();

app.listen(8080, () => { console.log(`listening to port 8080`) } )

app.get("/", (req, res) => {
    res.render("./landing.ejs")
});

app.get("/login", (req, res) => {
    res.send(`hello this is login page`);
})