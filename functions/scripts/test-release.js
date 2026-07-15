const escrowId = "9bG4ECyuwQWDcdl3yuYB"; // Copy a 'held' or 'shipped' ID from Firestore
const token = "609349b6-92f2-4757-b314-8a92a378b678";  // Copy the buyerConfirmToken from that same document

fetch("http://127.0.0.1:5001/holdpay-f920a/us-central1/releaseFunds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ escrowId, token })
})
.then(res => res.json())
.then(data => console.log(data))
.catch(err => console.error(err));