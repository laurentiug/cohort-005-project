# Cadence

An online course platform where Learners buy courses, work through their lessons, and can ask for their money back.

## Language

### People and buying

**Learner**:
A person who buys and takes courses.
_Avoid_: Student, buyer, customer ("user" only for the account itself)

**Purchase**:
A Learner's payment for one course. A Purchase becomes **Refunded** when the first Refund for it is Issued, and the Learner's Enrollment in that course ends at that point.
_Avoid_: Order, transaction

**Enrollment**:
A Learner's access to a course. It usually comes from a Purchase but can exist without one, for example on a free course or a Team Seat.
_Avoid_: Access, subscription

**Team Seat**:
A place on a team's licence that a Learner claims. It gives them an Enrollment without a Purchase of their own.
_Avoid_: Coupon, licence seat

**Admin**:
A Cadence staff member who runs the platform, including deciding Refund Requests.
_Avoid_: Staff, support, "us"

### Refunds

**Refund Request**:
A Learner's ask, with a written reason, to get their money back for a Purchase. A Purchase can have several Refund Requests over time, but at most one Requested and at most one Approved.
_Avoid_: Cancellation, cancel my purchase, Reversal, Chargeback, refund (when meaning the request)

**Refund Eligibility**:
Whether a Purchase may have a Refund Request raised for it right now.
_Avoid_: Cancellation offer, can cancel

**Refund Window**:
The period after a Purchase during which a Refund Request may be raised, counted in whole calendar days. It limits raising a Refund Request, not deciding one.
_Avoid_: Cancel window, cancellation period

**Refund Amount**:
How much a Refund returns, which is always the full amount the Learner paid for the Purchase and never a partial amount.
_Avoid_: Refundable amount, list price, partial refund

**Refund**:
One attempt to return the Refund Amount to a Learner, made because a Refund Request was Approved. A Declined Refund Request produces no Refund.
_Avoid_: Cancellation, Reversal, Chargeback, payout

**Chargeback**:
A payment dispute the Learner raises through their bank or card issuer, outside Cadence's own process. It is not a Refund Request and has no status in either lifecycle below.
_Avoid_: Using it for a Refund Request or a Refund

### Refund Request lifecycle

**Requested**:
The status of a Refund Request waiting for an Admin to decide it. It does not expire.
_Avoid_: Pending, open, in review

**Approved**:
The status of a Refund Request an Admin accepted, which leads to a Refund. It is final.
_Avoid_: Accepted, granted, refunded

**Declined**:
The status of a Refund Request an Admin rejected, so no Refund is made. It is final, but the Learner may raise a new Refund Request if Refund Eligibility still holds.
_Avoid_: Rejected, denied, cancelled

**Resolved**:
A Refund Request that is Approved or Declined, decided by a named Admin at a known time.
_Avoid_: Closed, processed, handled

### Refund lifecycle

**Issued**:
The status of a Refund that has been sent to the payment provider.
_Avoid_: Sent, processing, pending

**Completed**:
The status of a Refund whose money has reached the Learner. An Approved Refund Request has at most one Completed Refund.
_Avoid_: Paid, settled, done

**Failed**:
The status of a Refund the payment provider rejected. It marks one failed attempt: the Refund Request stays Approved, the Purchase stays Refunded, and an Admin issues another Refund.
_Avoid_: Declined, rejected, bounced
