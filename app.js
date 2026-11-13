
require("dotenv").config();

const express = require("express");
const path = require("path");

const connectDB = require("./config/database");
const routes = require("./routes");

const app = express();
const eyeTrackingRoutes = require("./routes/eyeTracking");

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({
    extended: true,
    limit: "20kb"
}));

app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

app.use("/", eyeTrackingRoutes);
app.use("/", routes);

app.use((req, res) => {
    res.status(404).send("Page not found");
});

const PORT = process.env.PORT || 3000;

const startServer = async () => {
    await connectDB();

    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
};

startServer();
