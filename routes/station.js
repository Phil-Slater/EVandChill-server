require("dotenv").config();
const express = require("express");
const router = express.Router();
const Station = require("../schema/station");
const StationResult = require("../schema/stationResult");
const User = require("../schema/user");
const latLongFromLocation = require("../util/locationToCoords");
const axios = require("axios");

const instance = axios.create({
    baseURL: `https://api.openchargemap.io/v3/poi/?key=${process.env.OCM_API_KEY}&countrycode=US`,
});

const sanitizeResponseData = (station) => {
    const connections = station.Connections.map((connection) => ({
        type: connection.ConnectionType.Title,
        speed: connection.ConnectionType.ID,
    }));
    let supportNumber = null;
    let supportEmail = null;
    if (station.OperatorInfo) {
        const { PhonePrimaryContact, ContactEmail } = station.OperatorInfo;
        if (PhonePrimaryContact) supportNumber = PhonePrimaryContact;
        if (ContactEmail) supportEmail = ContactEmail;
    }

    return {
        externalId: station.ID,
        lastUpdated: station.DataProvider.DateLastImported,
        name: station.AddressInfo.Title,
        address: station.AddressInfo.AddressLine1,
        cityStateZip: `${station.AddressInfo.Town}, ${station.AddressInfo.StateOrProvince} ${station.AddressInfo.Postcode}`,
        latitude: station.AddressInfo.Latitude,
        longitude: station.AddressInfo.Longitude,
        plugTypes: connections,
        supportNumber: supportNumber,
        supportEmail: supportEmail,
        operatingHours: station.AddressInfo.AccessComments
            ? station.AddressInfo.AccessComments
            : null,
    };
};

// search by zip code, city/state or user's location
router.post("/stations", async (req, res) => {
    const { zip, cityState, latitude, longitude } = req.body;
    let location = { lat: latitude, lng: longitude };

    if (!location.lat || !location.lng) {
        if (zip) {
            location = await latLongFromLocation(zip);
        } else if (cityState) {
            location = await latLongFromLocation(cityState);
        }
    }
    location.lat = location.lat.toFixed(1);
    location.lng = location.lng.toFixed(1);
    console.log(location);
    try {
        StationResult.findOrCreate(
            {
                location: `${location.lat},${location.lng}`,
            },
            async (err, stations) => {
                let { dateUpdated, response } = stations;
                // 2073600000 ms in a day
                if (
                    !dateUpdated ||
                    Date.now() - dateUpdated > 2073600000 ||
                    response.length === 0
                ) {
                    stationsResponse = await instance.get(
                        `&latitude=${location.lat}&longitude=${location.lng}`
                    );
                    stations.dateUpdated = Date.now();
                    stations.response = stationsResponse.data.map((station) =>
                        sanitizeResponseData(station)
                    );
                    stations.save();
                    saveStationsToDB(stations.response);
                }

                res.json({ stations: response, location: location });
            }
        );
    } catch (err) {}
});

router.get("/id/:stationId", async (req, res) => {
    try {
        Station.findOrCreate(
            { externalId: req.params.stationId },
            (err, dbStation) => {}
        );
        const response = await instance.get(
            `&chargepointid=${req.params.stationId}`
        );
        const station = response.data;
        const location = encodeURIComponent(
            `${station[0].AddressInfo.Latitude},${station[0].AddressInfo.Longitude}`
        );

        /* url setup*/
        const entertainmentURL = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${location}&radius=1500&type=movie_theater&key=${process.env.GOOGLE_PLACES_API_KEY}`;
        const restaurantsURL = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${location}&radius=1500&type=restaurant&key=${process.env.GOOGLE_PLACES_API_KEY}`;
        const storesURL = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${location}&radius=1500&type=store&key=${process.env.GOOGLE_PLACES_API_KEY}`;

        /* create requests */
        const entertainmentPromise = await axios.get(entertainmentURL);
        const restaurantsPromise = await axios.get(restaurantsURL);
        const storesPromise = await axios.get(storesURL);

        /* build data object to return from responses */

        const nearbyData = {
            theaters: entertainmentPromise.data.results,
            restaurants: restaurantsPromise.data.results,
            stores: storesPromise.data.results,
        };

        station[0].nearby = nearbyData;
        res.json(station);
    } catch (err) {
        console.log(err);
    }
});

router.post("/add-favorite", async (req, res) => {
    const { stationNumber, username, title, address } = req.body;

    const user = await User.findOne({ username: username }); // or however the JWT is set up

    if (user) {
        try {
            // add to favorites list of logged in user
            user.favorites.push({
                stationId: stationNumber,
                title: title,
                address: address,
                user: user._id,
            });
            const saved = await user.save();
            if (saved) {
                res.json({ success: true, message: "Added to favorites." });
            } else {
                res.json({ success: false, message: "Error!" });
            }
        } catch (err) {
            console.log(err);
        }
    } else {
        // user does not exist
        res.json({ success: false, message: "Invalid username." });
    }
});

router.delete("/remove-favorite", async (req, res) => {
    const stationNumber = req.body.stationNumber;
    const username = req.body.username;

    try {
        const success = await User.updateOne(
            { username: username },
            { $pull: { favorites: { stationId: stationNumber } } }
        );
        if (success) {
            res.json({ success: true, message: "Removed from favorites." });
        } else {
            res.json({ success: false, message: "Error!" });
        }
    } catch (err) {
        console.log(err);
    }
});

const saveStationsToDB = (stations) => {
    console.log("saving to DB...");
    stations.forEach((station) => {
        Station.findOrCreate({ externalId: station.ID }, (err, dbStation) => {
            dbStation.externalId = station.externalId;
            dbStation.lastUpdated = station.lastUpdated;
            dbStation.name = station.name;
            dbStation.address = station.address;
            dbStation.latitude = station.latitude;
            dbStation.longitude = station.longitude;
            dbStation.plugTypes = station.plugTypes;
            dbStation.supportNumber = station.supportNumber;
            dbStation.supportEmail = station.supportEmail;
            dbStation.operatingHours = station.operatingHours;
            dbStation.save();
        });
    });
};

module.exports = router;
