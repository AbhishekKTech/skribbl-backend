class Participant {
    constructor(socketId, displayName) {
        this.connectionId = socketId;
        this.displayName = displayName;
        this.totalPoints = 0;
        this.isCurrentlyDrawing = false;
        this.hasCorrectlyGuessed = false;
    }

    resetTurnState() {
        this.isCurrentlyDrawing = false;
        this.hasCorrectlyGuessed = false;
    }

    awardPoints(earnedPoints) {
        this.totalPoints += earnedPoints;
    }
}

module.exports = Participant;