const express = require('express')
const app = express()
const cors = require('cors')
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config()
const mailchimp = require("@mailchimp/mailchimp_marketing")
const port = process.env.PORT || 5000
const jwt = require('jsonwebtoken');
const res = require('express/lib/response');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)


app.use(cors())
app.use(express.json())

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PAS}@cluster0.vrths.mongodb.net/myFirstDatabase?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });


function verifyJWT(req, res, next) {
    const authHeader = req.headers.authorization
    if (!authHeader) {
        return res.status(401).send({ message: 'Unauthorized' })
    }
    const token = authHeader.split(' ')[1]
    jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, function (err, decoded) {
        if (err) {
            return res.status(403).send({ message: 'forbidden access' })
        }
        req.decoded = decoded
        next()
    })
}



async function run() {
    try {
        await client.connect()
        const serviceCollection = client.db('doctors_portal').collection('service')
        const bookingCollection = client.db('doctors_portal').collection('booking')
        const userCollection = client.db('doctors_portal').collection('users')
        const doctorCollection = client.db('doctors_portal').collection('doctors')
        const paymentCollection = client.db('doctors_portal').collection('payments')

        const verifyAdmin = async (req, res, next) => {
            const requester = req.decoded.email
            const requesterAccount = await userCollection.findOne({ email: requester })
            if (requesterAccount.role === 'admin') {
                next()
            }
            else {
                res.status(403).send({ message: 'Forbidden' })
            }
        }

        app.post('/create-payment-intent', verifyJWT, async (req, res) => {
            /*  const service = req.body
             const price = service.price */
            const { price } = req.body
            const amount = price * 100

            const paymentIntent = await stripe.paymentIntents.create({
                amount: amount,
                currency: 'usd',
                payment_method_types: [
                    'card'
                ]

            })
            res.send({
                clientSecret: paymentIntent.client_secret
            })
        })

        app.get('/service', async (req, res) => {
            const query = {}
            const cursor = serviceCollection.find(query).project({ name: 1 })
            const services = await cursor.toArray()
            console.log(services)
            res.send(services)
        })

        app.get('/user', verifyJWT, async (req, res) => {
            const users = await userCollection.find().toArray()
            res.send(users)
        })

        app.get('/admin/:email', async (req, res) => {
            const email = req.params.email
            const user = await userCollection.findOne({ email: email })
            const isAdmin = user.role === 'admin'
            res.send({ admin: isAdmin })
        })

        app.put('/user/admin/:email', verifyJWT, verifyAdmin, async (req, res) => {
            const email = req.params.email
            /*  const requester = req.decoded.email
             const requesterAccount = await userCollection.findOne({ email: requester })
             if (requesterAccount.role === 'admin') { */
            const filter = { email: email }
            const updateDoc = {
                $set: { role: 'admin' }
            }
            const result = await userCollection.updateOne(filter, updateDoc)
            res.send(result)
            // }
            /* else {
                res.status(403).send({ message: 'Forbidden' })
            } */
        })

        app.put('/user/:email', async (req, res) => {
            const email = req.params.email
            const user = req.body
            const filter = { email: email }
            const options = { upsert: true }
            const updateDoc = {
                $set: user
            }
            const result = await userCollection.updateOne(filter, updateDoc, options)
            const token = jwt.sign({ email: email }, process.env.ACCESS_TOKEN_SECRET, {
                expiresIn: '6h'
            })
            console.log(token)
            res.send({ result, token })
        })

        app.get('/available', async (req, res) => {
            const date = req.query.date || 'May 14, 2022'
            const services = await serviceCollection.find().toArray()
            const query = { date: date }

            const bookings = await bookingCollection.find(query).toArray()
            services.forEach(service => {
                const serviceBookings = bookings.filter(b => b.treatment === service.name)
                const booked = serviceBookings.map(s => s.slot)
                const available = service.slots.filter(s => !booked.includes(s))
                service.slots = available
            })
            res.send(services)
        })

        app.get('/booking', verifyJWT, async (req, res) => {
            const patient = req.query.patient
            const decodedEmail = req.decoded.email
            if (patient === decodedEmail) {
                const query = { patient: patient }
                const booking = await bookingCollection.find(query).toArray()
                return res.send(booking)
            }
            else {
                return res.status(403).send({ message: 'forbidden access' })
            }
        })

        app.get('/booking/:id', verifyJWT, async (req, res) => {
            const id = req.params.id
            const query = { _id: ObjectId(id) }
            const booking = await bookingCollection.findOne(query)
            res.send(booking)
        })

        app.post('/booking', async (req, res) => {
            const booking = req.body
            console.log(req.body)
            const query = { treatment: booking.treatment, date: booking.date, patient: booking.patient }
            const exists = await bookingCollection.findOne(query)
            if (exists) {
                return res.send({ success: false, booking: exists })
            }
            const result = await bookingCollection.insertOne(booking)
            /* mailchimp.setConfig({
                apiKey: process.env.EMAIL_SENDER_KEY,
                server: "us11",
            });
            const firstName = booking.patientName
            const email = booking.patient

            const listId = "e337d528b8";
            const subscribingUser = {
                firstName: firstName,
                email: email
            };
            const response = await mailchimp.lists.addListMember(listId, {
                email_address: subscribingUser.email,
                status: "pending",
                merge_fields: {
                    FNAME: subscribingUser.firstName,
                }
            });

            console.log(`Successfully added contact as an audience member. The contact's id is ${response.id}.`); */


            res.send({ success: true, result })
        })

        app.patch('/booking/:id', verifyJWT, async (req, res) => {
            const id = req.params.id
            const payment = req.body
            const filter = { _id: ObjectId(id) }
            const updateDoc = {
                $set: {
                    paid: true,
                    transactionId: payment.transactionId
                }
            }
            const result = await paymentCollection.insertOne(payment)
            const updatedBooking = await bookingCollection.updateOne(filter, updateDoc)
            res.send(updateDoc)
        })

        app.get('/doctor', async (req, res) => {
            const doctors = await doctorCollection.find().toArray()
            res.send(doctors)
        })

        app.post('/doctor', verifyJWT, verifyAdmin, async (req, res) => {
            const doctor = req.body
            const result = await doctorCollection.insertOne(doctor)
            res.send(result)
        })

        app.delete('/doctor/:email', verifyJWT, verifyAdmin, async (req, res) => {
            const email = req.params.email
            const filter = { email: email }
            const result = await doctorCollection.deleteOne(filter)
            res.send(result)
        })
    }
    finally {

    }
}

run().catch(console.dir)

app.get('/', (req, res) => {
    res.send('doctor portal running')
})

app.listen(port, () => {
    console.log(`doctor app listening on port ${port}`)
})