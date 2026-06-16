import { DataTypes, Sequelize } from 'sequelize';

let Session;

/**
 * initSession Model.
 * @constructor
 * @param {Sequelize} sequelize - The title of the book.
 */
export const initSessionModel = (sequelize) => {
  Session = sequelize.define('Session', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    session_id: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: false,
      validate: {
        notEmpty: true
      }
    },
    name: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null
    },
    status: {
      type: DataTypes.ENUM('recording', 'stopped'),
      allowNull: false,
      defaultValue: 'recording'
    },
    start_time: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW
    },
    end_time: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null
    },
    data_point_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {}
    }
  }, {
    tableName: 'sessions',
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ['session_id']
      },
      {
        fields: ['status']
      },
      {
        fields: ['start_time']
      }
    ]
  });

  return Session;
};

export { Session };
